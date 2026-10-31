terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}
variable "name" { type = string }

resource "aws_sqs_queue" "dlq" {
  name                      = "${var.name}-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}
resource "aws_sqs_queue" "jobs" {
  name                       = var.name
  visibility_timeout_seconds = 1080
  message_retention_seconds  = 345600
  receive_wait_time_seconds  = 20
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = 2
  })
}
resource "aws_sqs_queue_redrive_allow_policy" "dlq" {
  queue_url = aws_sqs_queue.dlq.url
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.jobs.arn]
  })
}
resource "aws_sqs_queue_policy" "tls_only" {
  for_each = {
    jobs = { url = aws_sqs_queue.jobs.url, arn = aws_sqs_queue.jobs.arn }
    dlq  = { url = aws_sqs_queue.dlq.url, arn = aws_sqs_queue.dlq.arn }
  }
  queue_url = each.value.url
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport", Effect = "Deny", Principal = "*"
      Action    = "sqs:*", Resource = each.value.arn
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}
output "arn" { value = aws_sqs_queue.jobs.arn }
output "url" { value = aws_sqs_queue.jobs.url }
output "name" { value = aws_sqs_queue.jobs.name }
output "dlq_name" { value = aws_sqs_queue.dlq.name }
