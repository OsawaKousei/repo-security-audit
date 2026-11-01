# All providers are mocked: these plan tests do not contact or change AWS.
mock_provider "aws" {}

variables {
  aws_account_id      = "103492189525"
  project_name        = "repo-sentinel"
  environment         = "dev"
  public_domain       = "repo-sentinel-dev.prj.kupac.co.jp"
  acm_certificate_arn = "arn:aws:acm:us-east-1:103492189525:certificate/7b6cdfdb-5b63-4572-936c-f7362c471713"
  route53_zone_id     = "Z06893261CC94H6AKTJGK"
  enable_runtime      = false
}

run "fixed_dev_domain" {
  command = plan

  assert {
    condition     = output.frontend_url == "https://repo-sentinel-dev.prj.kupac.co.jp"
    error_message = "The dev URL must be fixed before CloudFront creation."
  }
  assert {
    condition = output.cognito_callback_urls == [
      "https://repo-sentinel-dev.prj.kupac.co.jp/auth/callback",
      "http://localhost:5173/auth/callback",
    ]
    error_message = "The initial plan must register both dev HTTPS and localhost callbacks."
  }
}

run "reject_production_domain" {
  command = plan
  variables {
    public_domain = "repo-sentinel.prj.kupac.co.jp"
  }
  expect_failures = [var.public_domain]
}

run "reject_generated_domain" {
  command = plan
  variables {
    public_domain = "d111111abcdef8.cloudfront.net"
  }
  expect_failures = [var.public_domain]
}

run "reject_production_environment" {
  command = plan
  variables {
    environment   = "prod"
    public_domain = "repo-sentinel-prod.prj.kupac.co.jp"
  }
  expect_failures = [var.environment]
}
