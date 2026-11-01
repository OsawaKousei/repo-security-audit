mock_provider "aws" {}

variables {
  name                = "repo-sentinel-dev"
  bucket_name         = "repo-sentinel-dev-frontend-103492189525"
  public_domain       = "repo-sentinel-dev.prj.kupac.co.jp"
  route53_zone_id     = "Z06893261CC94H6AKTJGK"
  acm_certificate_arn = "arn:aws:acm:us-east-1:103492189525:certificate/7b6cdfdb-5b63-4572-936c-f7362c471713"
  api_url             = "https://example.lambda-url.ap-northeast-1.on.aws/"
}

run "disabled_api_has_no_origin_forwarding" {
  command = plan
  module {
    source = "../../modules/frontend"
  }
  variables {
    api_enabled = false
  }
  assert {
    condition = alltrue([
      for behavior in aws_cloudfront_distribution.this.ordered_cache_behavior :
      behavior.origin_request_policy_id == null && behavior.target_origin_id == "frontend"
      if startswith(behavior.path_pattern, "/api")
    ])
    error_message = "An unavailable API must not forward viewer headers to S3."
  }
}

run "enabled_api_uses_lambda_compatible_managed_policy" {
  command = plan
  module {
    source = "../../modules/frontend"
  }
  variables {
    api_enabled = true
  }
  assert {
    condition = alltrue([
      for behavior in aws_cloudfront_distribution.this.ordered_cache_behavior :
      behavior.origin_request_policy_id == "b689b0a8-53d0-40ab-baf2-68738e2966ac" &&
      behavior.target_origin_id == "api" &&
      behavior.cache_policy_id == "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
      if startswith(behavior.path_pattern, "/api")
    ])
    error_message = "API paths must use AllViewerExceptHostHeader with caching disabled."
  }
}
