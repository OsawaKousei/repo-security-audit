terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}
variable "enabled" { type = bool }
variable "name" { type = string }
variable "artifact_path" { type = string }
variable "npm_layer_arn" { type = string }
variable "jobs_table_name" { type = string }
variable "jobs_table_arn" { type = string }
variable "queue_arn" { type = string }
variable "openai_secret_arn" { type = string }
variable "allowed_user_sub" { type = string }
variable "log_retention_days" { type = number }
variable "aws_account_id" { type = string }
variable "aws_region" { type = string }
variable "resource_prefix" { type = string }
variable "queue_url" { type = string }
variable "ai_mode" { type = string }
variable "reserved_concurrency" { type = number }
variable "openai_hard_limit_confirmed" { type = bool }

resource "aws_cloudwatch_log_group" "this" {
  count             = var.enabled ? 1 : 0
  name              = "/aws/lambda/${var.name}"
  retention_in_days = var.log_retention_days
}
resource "aws_iam_role" "this" {
  count = var.enabled ? 1 : 0
  name  = var.name
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole"
    }]
  })
}
resource "aws_iam_role_policy" "this" {
  count = var.enabled ? 1 : 0
  name  = "${var.name}-runtime"
  role  = aws_iam_role.this[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "JobStorage", Effect = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:ConditionCheckItem"]
        Resource = var.jobs_table_arn
        Condition = { "ForAllValues:StringEquals" = {
          "dynamodb:LeadingKeys" = ["USER#${var.allowed_user_sub}", "SYSTEM", "AI_BUDGET"]
        } }
      },
      {
        Sid      = "ConsumeAudit", Effect = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource = var.queue_arn
      },
      { Sid = "ReadOpenAIKey", Effect = "Allow", Action = "secretsmanager:GetSecretValue", Resource = var.openai_secret_arn },
      {
        Sid      = "WriteFunctionLogs", Effect = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.this[0].arn}:*"
      }
    ]
  })
}
resource "aws_lambda_function" "this" {
  count                          = var.enabled ? 1 : 0
  function_name                  = var.name
  description                    = "Repo Sentinel single-job security audit Worker"
  role                           = aws_iam_role.this[0].arn
  runtime                        = "nodejs24.x"
  architectures                  = ["x86_64"]
  handler                        = "lambda.handler"
  filename                       = var.artifact_path
  source_code_hash               = var.artifact_path == null ? null : (fileexists(var.artifact_path) ? filebase64sha256(var.artifact_path) : null)
  layers                         = [var.npm_layer_arn]
  memory_size                    = 1024
  timeout                        = 180
  reserved_concurrent_executions = var.reserved_concurrency
  ephemeral_storage {
    size = 512
  }
  environment {
    variables = {
      NODE_ENV                    = "production"
      APP_ENV                     = "dev"
      DYNAMODB_TABLE              = var.jobs_table_name
      OPENAI_SECRET_ARN           = var.openai_secret_arn
      ALLOWED_USER_SUB            = var.allowed_user_sub
      AUDIT_MODE                  = "audit"
      AI_MODE                     = var.ai_mode
      OPENAI_HARD_LIMIT_CONFIRMED = tostring(var.openai_hard_limit_confirmed)
      AWS_ACCOUNT_ID              = var.aws_account_id
      RESOURCE_PREFIX             = var.resource_prefix
      AUDIT_QUEUE_URL             = var.queue_url
      NPM_CLI_PATH                = "/opt/nodejs/node_modules/npm/bin/npm-cli.js"
      AUDIT_DAILY_LIMIT           = "5"
      AUDIT_CONCURRENCY           = "1"
    }
  }
  depends_on = [aws_iam_role_policy.this]
}
resource "aws_lambda_event_source_mapping" "this" {
  count                              = var.enabled ? 1 : 0
  event_source_arn                   = var.queue_arn
  function_name                      = aws_lambda_function.this[0].arn
  batch_size                         = 1
  maximum_batching_window_in_seconds = 0
  function_response_types            = ["ReportBatchItemFailures"]
  scaling_config {
    maximum_concurrency = 2
  }
  depends_on = [aws_iam_role_policy.this]
}
output "function_name" { value = one(aws_lambda_function.this[*].function_name) }
output "log_group_name" { value = one(aws_cloudwatch_log_group.this[*].name) }
