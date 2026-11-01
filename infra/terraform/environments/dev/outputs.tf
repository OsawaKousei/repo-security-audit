output "frontend_url" { value = module.frontend.url }
output "cloudfront_domain_name" { value = module.frontend.domain_name }
output "frontend_bucket" { value = module.frontend.bucket_name }
output "cloudfront_distribution_id" { value = module.frontend.distribution_id }
output "cognito_user_pool_id" { value = module.auth.user_pool_id }
output "cognito_client_id" { value = module.auth.client_id }
output "cognito_issuer" { value = module.auth.issuer }
output "cognito_login_url" { value = "https://${module.auth.login_domain}.auth.${var.aws_region}.amazoncognito.com" }
output "cognito_callback_urls" { value = [for origin in local.auth_origins : "${origin}/auth/callback"] }
output "dynamodb_table_name" { value = module.database.name }
output "audit_queue_url" { value = module.queue.url }
output "openai_secret_arn" { value = aws_secretsmanager_secret.openai.arn }
output "runtime_enabled" { value = var.enable_runtime }
output "api_function_name" { value = module.api.function_name }
output "worker_function_name" { value = module.worker.function_name }
output "api_function_url" { value = module.api.function_url }
output "worker_npm_layer_arn" { value = var.worker_npm_layer_path != null ? one(aws_lambda_layer_version.npm[*].arn) : var.worker_npm_layer_arn }
