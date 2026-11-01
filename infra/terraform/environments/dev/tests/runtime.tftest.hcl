mock_provider "aws" {}

variables {
  aws_account_id      = "103492189525"
  public_domain       = "repo-sentinel-dev.prj.kupac.co.jp"
  acm_certificate_arn = "arn:aws:acm:us-east-1:103492189525:certificate/7b6cdfdb-5b63-4572-936c-f7362c471713"
  route53_zone_id     = "Z06893261CC94H6AKTJGK"
}

run "runtime_contracts" {
  command = plan
  variables {
    enable_runtime = true
    # Provider is mocked: a readable file exercises path/hash validation only.
    api_artifact_path     = "main.tf"
    worker_artifact_path  = "main.tf"
    worker_npm_layer_path = "main.tf"
    allowed_user_sub      = "11111111-2222-4333-8444-555555555555"
  }
  assert {
    condition     = length(aws_lambda_layer_version.npm) == 1
    error_message = "The runtime must manage the clean-built npm layer."
  }
  assert {
    condition     = length(aws_cloudwatch_log_metric_filter.application) == 6
    error_message = "Handled API/Worker/AI and partial-record failures must be monitored."
  }
  assert {
    condition     = var.ai_mode == "mock" && !var.openai_hard_limit_confirmed
    error_message = "The initial AWS integration must default to mock AI."
  }
  assert {
    condition     = length(aws_budgets_budget.monthly) == 0 && length(aws_sns_topic.operations) == 0
    error_message = "Runtime must work without optional AWS budget/SNS notifications."
  }
}

run "openai_requires_confirmation" {
  command = plan
  variables {
    ai_mode = "openai"
  }
  expect_failures = [var.ai_mode]
}

run "free_budget_email_does_not_enable_sns" {
  command = plan
  variables {
    budget_monthly_usd = 10
    budget_email       = "test@example.invalid"
  }
  assert {
    condition     = length(aws_budgets_budget.monthly) == 1 && length(aws_sns_topic.operations) == 0 && length(aws_sns_topic_subscription.operations) == 0
    error_message = "Budget monitoring/email must not implicitly enable SNS or operational-alarm notifications."
  }
}

run "layer_sources_are_exclusive" {
  command = plan
  variables {
    worker_npm_layer_path = "main.tf"
    worker_npm_layer_arn  = "arn:aws:lambda:ap-northeast-1:103492189525:layer:example:1"
  }
  expect_failures = [var.worker_npm_layer_path]
}
