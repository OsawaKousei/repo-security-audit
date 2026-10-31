terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}
variable "enabled" { type = bool }
variable "name" { type = string }
variable "artifact_path" { type = string }
variable "jobs_table_name" { type = string }
variable "jobs_table_arn" { type = string }
variable "queue_url" { type = string }
variable "queue_arn" { type = string }
variable "cognito_issuer" { type = string }
variable "cognito_client_id" { type = string }
variable "allowed_user_sub" { type = string }
variable "log_retention_days" { type = number }

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
        Action   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:ConditionCheckItem"]
        Resource = var.jobs_table_arn
      },
      { Sid = "SubmitAudit", Effect = "Allow", Action = "sqs:SendMessage", Resource = var.queue_arn },
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
  description                    = "Repo Sentinel authenticated API"
  role                           = aws_iam_role.this[0].arn
  runtime                        = "nodejs24.x"
  architectures                  = ["x86_64"]
  handler                        = "lambda.handler"
  filename                       = var.artifact_path
  source_code_hash               = var.artifact_path == null ? null : (fileexists(var.artifact_path) ? filebase64sha256(var.artifact_path) : null)
  memory_size                    = 256
  timeout                        = 15
  reserved_concurrent_executions = 2
  environment {
    variables = {
      NODE_ENV          = "production"
      APP_ENV           = "dev"
      DYNAMODB_TABLE    = var.jobs_table_name
      AUDIT_QUEUE_URL   = var.queue_url
      COGNITO_ISSUER    = var.cognito_issuer
      COGNITO_CLIENT_ID = var.cognito_client_id
      COGNITO_TOKEN_USE = "access"
      ALLOWED_USER_SUB  = var.allowed_user_sub
      JWT_HEADER        = "X-Access-Token"
      AUDIT_MODE        = "audit"
    }
  }
  depends_on = [aws_iam_role_policy.this]
}
resource "aws_lambda_function_url" "this" {
  count              = var.enabled ? 1 : 0
  function_name      = aws_lambda_function.this[0].function_name
  authorization_type = "AWS_IAM"
  invoke_mode        = "BUFFERED"
}
output "function_name" { value = one(aws_lambda_function.this[*].function_name) }
output "function_url" { value = one(aws_lambda_function_url.this[*].function_url) }
