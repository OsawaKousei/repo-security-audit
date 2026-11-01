terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}
variable "name" { type = string }
variable "bucket_name" { type = string }
variable "public_domain" { type = string }
variable "route53_zone_id" { type = string }
variable "acm_certificate_arn" { type = string }
variable "api_enabled" { type = bool }
variable "api_url" { type = string }

resource "aws_s3_bucket" "this" {
  bucket        = var.bucket_name
  force_destroy = false
}
resource "aws_s3_bucket_public_access_block" "this" {
  bucket                  = aws_s3_bucket.this.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_ownership_controls" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}
resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id
  versioning_configuration {
    status = "Enabled"
  }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}
resource "aws_cloudfront_origin_access_control" "s3" {
  name                              = "${var.name}-s3"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}
resource "aws_cloudfront_origin_access_control" "api" {
  count                             = var.api_enabled ? 1 : 0
  name                              = "${var.name}-api"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}
# Until the AWS runtime is deliberately enabled, API requests fail closed.
resource "aws_cloudfront_function" "api_unavailable" {
  name    = "${var.name}-api-unavailable"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = file("${path.module}/api-unavailable.js")
}
resource "aws_cloudfront_function" "spa" {
  name    = "${var.name}-spa"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = file("${path.module}/spa.js")
}
resource "aws_cloudfront_distribution" "this" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  aliases             = [var.public_domain]
  price_class         = "PriceClass_All"
  comment             = var.name
  http_version        = "http2and3"

  origin {
    domain_name              = aws_s3_bucket.this.bucket_regional_domain_name
    origin_id                = "frontend"
    origin_access_control_id = aws_cloudfront_origin_access_control.s3.id
  }
  dynamic "origin" {
    for_each = var.api_enabled ? [true] : []
    content {
      domain_name              = trimsuffix(trimprefix(var.api_url, "https://"), "/")
      origin_id                = "api"
      origin_access_control_id = aws_cloudfront_origin_access_control.api[0].id
      custom_origin_config {
        http_port              = 80
        https_port             = 443
        origin_protocol_policy = "https-only"
        origin_ssl_protocols   = ["TLSv1.2"]
      }
    }
  }
  default_cache_behavior {
    target_origin_id       = "frontend"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled for the SPA shell
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa.arn
    }
  }
  ordered_cache_behavior {
    path_pattern           = "/assets/*"
    target_origin_id       = "frontend"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = "658327ea-f89d-4fab-a63d-7e88639e58f6" # CachingOptimized for fingerprinted Vite assets
  }
  dynamic "ordered_cache_behavior" {
    for_each = ["/api", "/api/*"]
    content {
      path_pattern           = ordered_cache_behavior.value
      target_origin_id       = var.api_enabled ? "api" : "frontend"
      viewer_protocol_policy = "https-only"
      allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
      cached_methods         = ["GET", "HEAD"]
      compress               = true
      cache_policy_id        = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
      # AWS-managed AllViewerExceptHostHeader supports Lambda function URL
      # origins without individually listing restricted X-Amz-* headers.
      # OAC signs Authorization; the application's JWT uses X-Access-Token.
      origin_request_policy_id = var.api_enabled ? "b689b0a8-53d0-40ab-baf2-68738e2966ac" : null
      dynamic "function_association" {
        for_each = var.api_enabled ? [] : [true]
        content {
          event_type   = "viewer-request"
          function_arn = aws_cloudfront_function.api_unavailable.arn
        }
      }
    }
  }
  restrictions {
    geo_restriction { restriction_type = "none" }
  }
  viewer_certificate {
    acm_certificate_arn      = var.acm_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}
resource "aws_s3_bucket_policy" "this" {
  bucket = aws_s3_bucket.this.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "CloudFrontReadOnly", Effect = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }, Action = "s3:GetObject"
        Resource  = "${aws_s3_bucket.this.arn}/*"
        Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.this.arn } }
      },
      {
        Sid       = "DenyInsecureTransport", Effect = "Deny", Principal = "*", Action = "s3:*"
        Resource  = [aws_s3_bucket.this.arn, "${aws_s3_bucket.this.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      }
    ]
  })
  depends_on = [aws_s3_bucket_public_access_block.this]
}
resource "aws_route53_record" "this" {
  for_each        = toset(["A", "AAAA"])
  zone_id         = var.route53_zone_id
  name            = var.public_domain
  type            = each.value
  allow_overwrite = false
  alias {
    name                   = aws_cloudfront_distribution.this.domain_name
    zone_id                = aws_cloudfront_distribution.this.hosted_zone_id
    evaluate_target_health = false
  }
}
output "bucket_name" { value = aws_s3_bucket.this.bucket }
output "distribution_id" { value = aws_cloudfront_distribution.this.id }
output "distribution_arn" { value = aws_cloudfront_distribution.this.arn }
output "domain_name" { value = aws_cloudfront_distribution.this.domain_name }
output "url" { value = "https://${var.public_domain}" }
