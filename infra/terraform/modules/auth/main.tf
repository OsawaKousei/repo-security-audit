terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "name" { type = string }
variable "domain_prefix" { type = string }
variable "callback_urls" { type = list(string) }
variable "logout_urls" { type = list(string) }

resource "aws_cognito_user_pool" "this" {
  name                     = var.name
  user_pool_tier           = "ESSENTIALS"
  deletion_protection      = "ACTIVE"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  mfa_configuration        = "ON"

  admin_create_user_config {
    allow_admin_create_user_only = true
  }
  software_token_mfa_configuration {
    enabled = true
  }
  username_configuration {
    case_sensitive = false
  }
  password_policy {
    minimum_length                   = 16
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 3
  }
  account_recovery_setting {
    recovery_mechanism {
      name     = "admin_only"
      priority = 1
    }
  }
}

resource "aws_cognito_user_pool_client" "browser" {
  name                                          = "${var.name}-browser"
  user_pool_id                                  = aws_cognito_user_pool.this.id
  generate_secret                               = false
  allowed_oauth_flows_user_pool_client          = true
  allowed_oauth_flows                           = ["code"]
  allowed_oauth_scopes                          = ["openid", "email", "profile"]
  supported_identity_providers                  = ["COGNITO"]
  callback_urls                                 = var.callback_urls
  logout_urls                                   = var.logout_urls
  default_redirect_uri                          = var.callback_urls[0]
  prevent_user_existence_errors                 = "ENABLED"
  enable_token_revocation                       = true
  enable_propagate_additional_user_context_data = false
  explicit_auth_flows                           = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  access_token_validity                         = 15
  id_token_validity                             = 15
  refresh_token_validity                        = 1

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}

resource "aws_cognito_user_pool_domain" "this" {
  domain                = var.domain_prefix
  user_pool_id          = aws_cognito_user_pool.this.id
  managed_login_version = 2
}

resource "aws_cognito_managed_login_branding" "browser" {
  client_id                   = aws_cognito_user_pool_client.browser.id
  user_pool_id                = aws_cognito_user_pool.this.id
  use_cognito_provided_values = true
  depends_on                  = [aws_cognito_user_pool_domain.this]
}

output "user_pool_id" { value = aws_cognito_user_pool.this.id }
output "client_id" { value = aws_cognito_user_pool_client.browser.id }
output "issuer" { value = "https://${aws_cognito_user_pool.this.endpoint}" }
output "login_domain" { value = aws_cognito_user_pool_domain.this.domain }
