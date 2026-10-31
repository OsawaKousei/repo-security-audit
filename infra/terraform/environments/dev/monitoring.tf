resource "aws_sns_topic" "operations" {
  count = var.budget_email != null ? 1 : 0
  name  = "${local.name}-operations"
}
resource "aws_sns_topic_policy" "operations" {
  count = var.budget_email != null ? 1 : 0
  arn   = aws_sns_topic.operations[0].arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "CloudWatchAlarms", Effect = "Allow"
      Principal = { Service = "cloudwatch.amazonaws.com" }
      Action    = "sns:Publish", Resource = aws_sns_topic.operations[0].arn
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.aws_account_id }
        ArnLike      = { "aws:SourceArn" = "arn:aws:cloudwatch:${var.aws_region}:${var.aws_account_id}:alarm:${local.name}-*" }
      }
    }]
  })
}
resource "aws_sns_topic_subscription" "operations" {
  count     = var.budget_email != null ? 1 : 0
  topic_arn = aws_sns_topic.operations[0].arn
  protocol  = "email"
  endpoint  = var.budget_email
}

locals {
  alarm_actions = aws_sns_topic.operations[*].arn
  queue_alarms = {
    dlq = {
      name        = module.queue.dlq_name, metric = "ApproximateNumberOfMessagesVisible", threshold = 1
      description = "Audit messages reached the DLQ; investigate before redrive."
    }
    age = {
      name        = module.queue.name, metric = "ApproximateAgeOfOldestMessage", threshold = 600
      description = "Audit queue has a message older than ten minutes."
    }
  }
}
resource "aws_cloudwatch_metric_alarm" "queue" {
  for_each            = local.queue_alarms
  alarm_name          = "${local.name}-queue-${each.key}"
  alarm_description   = each.value.description
  namespace           = "AWS/SQS"
  metric_name         = each.value.metric
  dimensions          = { QueueName = each.value.name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = each.value.threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}
resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = var.enable_runtime ? {
    api    = module.api.function_name
    worker = module.worker.function_name
  } : {}
  alarm_name          = "${local.name}-${each.key}-errors"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = each.value }
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}
resource "aws_cloudwatch_metric_alarm" "worker_duration" {
  count               = var.enable_runtime ? 1 : 0
  alarm_name          = "${local.name}-worker-duration"
  alarm_description   = "Worker duration is approaching its 180-second timeout."
  namespace           = "AWS/Lambda"
  metric_name         = "Duration"
  dimensions          = { FunctionName = module.worker.function_name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 170000
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_budgets_budget" "monthly" {
  count        = var.budget_monthly_usd != null ? 1 : 0
  name         = "${local.name}-monthly"
  budget_type  = "COST"
  time_unit    = "MONTHLY"
  limit_amount = tostring(var.budget_monthly_usd)
  limit_unit   = "USD"
  cost_filter {
    name   = "TagKeyValue"
    values = [format("user:Project$%s", var.project_name)]
  }
  dynamic "notification" {
    for_each = [80, 100]
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = [var.budget_email]
    }
  }
}
