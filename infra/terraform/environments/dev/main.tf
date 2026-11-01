locals {
  name         = "${var.project_name}-${var.environment}"
  auth_origins = ["https://${var.public_domain}", "http://localhost:5173"]
}

module "auth" {
  source        = "../../modules/auth"
  name          = local.name
  domain_prefix = "${local.name}-${var.aws_account_id}"
  callback_urls = [for origin in local.auth_origins : "${origin}/auth/callback"]
  logout_urls   = [for origin in local.auth_origins : "${origin}/"]
}

module "database" {
  source = "../../modules/database"
  name   = "${local.name}-jobs"
}

module "queue" {
  source = "../../modules/queue"
  name   = "${local.name}-audits"
}

# Only the empty secret container is managed. Secret values are injected out of band.
resource "aws_secretsmanager_secret" "openai" {
  name                    = "${local.name}/openai-api-key"
  description             = "Worker-only OpenAI API key; value is never supplied through Terraform"
  recovery_window_in_days = 30
}

module "api" {
  source                      = "../../modules/api"
  enabled                     = var.enable_runtime
  name                        = "${local.name}-api"
  artifact_path               = var.api_artifact_path
  jobs_table_name             = module.database.name
  jobs_table_arn              = module.database.arn
  queue_url                   = module.queue.url
  queue_arn                   = module.queue.arn
  cognito_issuer              = module.auth.issuer
  cognito_client_id           = module.auth.client_id
  allowed_user_sub            = var.allowed_user_sub
  aws_account_id              = var.aws_account_id
  aws_region                  = var.aws_region
  resource_prefix             = local.name
  ai_mode                     = var.ai_mode
  reserved_concurrency        = var.lambda_reserved_concurrency
  openai_hard_limit_confirmed = var.openai_hard_limit_confirmed
  log_retention_days          = var.log_retention_days
}

resource "aws_lambda_layer_version" "npm" {
  count                    = var.enable_runtime && var.worker_npm_layer_path != null ? 1 : 0
  layer_name               = "${local.name}-npm"
  description              = "Pinned npm for audit-only execution; built from the workspace lockfile"
  filename                 = var.worker_npm_layer_path
  source_code_hash         = filebase64sha256(var.worker_npm_layer_path)
  compatible_runtimes      = ["nodejs24.x"]
  compatible_architectures = ["x86_64"]
}

module "worker" {
  source                      = "../../modules/worker"
  enabled                     = var.enable_runtime
  name                        = "${local.name}-worker"
  artifact_path               = var.worker_artifact_path
  npm_layer_arn               = var.worker_npm_layer_path != null ? one(aws_lambda_layer_version.npm[*].arn) : var.worker_npm_layer_arn
  jobs_table_name             = module.database.name
  jobs_table_arn              = module.database.arn
  queue_arn                   = module.queue.arn
  openai_secret_arn           = aws_secretsmanager_secret.openai.arn
  allowed_user_sub            = var.allowed_user_sub
  aws_account_id              = var.aws_account_id
  aws_region                  = var.aws_region
  resource_prefix             = local.name
  queue_url                   = module.queue.url
  ai_mode                     = var.ai_mode
  reserved_concurrency        = var.lambda_reserved_concurrency
  openai_hard_limit_confirmed = var.openai_hard_limit_confirmed
  log_retention_days          = var.log_retention_days
}

module "frontend" {
  source              = "../../modules/frontend"
  name                = local.name
  bucket_name         = "${local.name}-frontend-${var.aws_account_id}"
  public_domain       = var.public_domain
  route53_zone_id     = var.route53_zone_id
  acm_certificate_arn = var.acm_certificate_arn
  api_enabled         = var.enable_runtime
  api_url             = module.api.function_url
}

resource "aws_lambda_permission" "cloudfront_url" {
  count                  = var.enable_runtime ? 1 : 0
  statement_id           = "AllowCloudFrontFunctionURL"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = module.api.function_name
  principal              = "cloudfront.amazonaws.com"
  source_arn             = module.frontend.distribution_arn
  function_url_auth_type = "AWS_IAM"
}
resource "aws_lambda_permission" "cloudfront_invoke" {
  count                    = var.enable_runtime ? 1 : 0
  statement_id             = "AllowCloudFrontInvokeViaURL"
  action                   = "lambda:InvokeFunction"
  function_name            = module.api.function_name
  principal                = "cloudfront.amazonaws.com"
  source_arn               = module.frontend.distribution_arn
  invoked_via_function_url = true
}
