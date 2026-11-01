variable "aws_region" {
  description = "Primary region for Repo Sentinel resources."
  type        = string
  default     = "ap-northeast-1"
}

variable "aws_profile" {
  description = "Shared AWS configuration profile; credentials are never stored in Terraform variables."
  type        = string
  default     = null
  nullable    = true
}

variable "aws_account_id" {
  description = "Expected AWS account; the provider refuses other accounts."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must contain exactly 12 digits."
  }
}

variable "project_name" {
  description = "Project identifier used in resource names and tags."
  type        = string
  default     = "repo-sentinel"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}[a-z0-9]$", var.project_name))
    error_message = "Use a lowercase project identifier with letters, digits, and internal hyphens."
  }
}

variable "environment" {
  description = "Environment managed by this root module."
  type        = string
  default     = "dev"

  validation {
    condition     = var.environment == "dev"
    error_message = "This root module manages dev only; prod needs a separate configuration and State key."
  }
}

variable "public_domain" {
  description = "Fixed dev host shared by CloudFront, Route 53, and Cognito. The production host is not accepted."
  type        = string

  validation {
    condition     = var.public_domain == "${var.project_name}-${var.environment}.prj.kupac.co.jp"
    error_message = "This dev root requires <project_name>-dev.prj.kupac.co.jp; never use the production host or a CloudFront-generated domain."
  }
}

variable "acm_certificate_arn" {
  description = "Existing us-east-1 ACM certificate covering the dev host; the certificate and validation records are not managed here."
  type        = string

  validation {
    condition     = can(regex("^arn:aws:acm:us-east-1:${var.aws_account_id}:certificate/[0-9a-f-]+$", var.acm_certificate_arn))
    error_message = "Use a us-east-1 ACM certificate ARN belonging to the expected AWS account."
  }
}

variable "route53_zone_id" {
  description = "Existing public kupac.co.jp hosted zone containing the dev host."
  type        = string

  validation {
    condition     = can(regex("^Z[A-Z0-9]+$", var.route53_zone_id))
    error_message = "Use a Route 53 hosted zone ID without the /hostedzone/ prefix."
  }
}

variable "tags" {
  description = "Additional AWS resource tags."
  type        = map(string)
  default     = {}
}

variable "enable_runtime" {
  description = "Enable API/Worker Lambda and SQS consumption only after AWS application artifacts and Cognito authorization are ready."
  type        = bool
  default     = false

  validation {
    condition = !var.enable_runtime || (
      can(filebase64sha256(var.api_artifact_path)) &&
      can(filebase64sha256(var.worker_artifact_path)) &&
      (var.worker_npm_layer_arn != null || can(filebase64sha256(var.worker_npm_layer_path))) && var.allowed_user_sub != null
    )
    error_message = "Runtime requires both Lambda ZIP artifacts, a Node.js 24 npm layer, and the allowed Cognito sub. AWS budget notifications are optional."
  }
}
variable "worker_npm_layer_path" {
  description = "Clean-built npm layer ZIP; Terraform publishes a version when runtime is enabled. Mutually exclusive with an existing ARN."
  type        = string
  default     = null
  validation {
    condition     = var.worker_npm_layer_path == null || var.worker_npm_layer_arn == null
    error_message = "Specify an npm layer ZIP or an existing version ARN, not both."
  }
}
variable "ai_mode" {
  description = "Start with mock AI for AWS integration; openai requires explicit hard-limit confirmation and an injected dev secret."
  type        = string
  default     = "mock"
  validation {
    condition     = contains(["mock", "openai"], var.ai_mode) && (var.ai_mode != "openai" || var.openai_hard_limit_confirmed)
    error_message = "Use mock or openai; openai requires openai_hard_limit_confirmed=true."
  }
}
variable "openai_hard_limit_confirmed" {
  description = "Operator confirmation that the dedicated dev OpenAI Project has a $10 hard spend limit."
  type        = bool
  default     = false
}
variable "lambda_reserved_concurrency" {
  description = "2 reserves/caps each function when the account quota permits; -1 uses the unreserved pool for low-quota dev accounts. SQS still caps Worker deliveries at 2."
  type        = number
  default     = 2
  validation {
    condition     = contains([-1, 2], var.lambda_reserved_concurrency)
    error_message = "Use 2 with sufficient account quota, or -1 for unreserved dev execution."
  }
}

variable "api_artifact_path" {
  description = "Path to the clean-built API ZIP with lambda.handler at the archive root."
  type        = string
  default     = null
}
variable "worker_artifact_path" {
  description = "Path to the clean-built SQS Worker ZIP with lambda.handler at the archive root."
  type        = string
  default     = null
}
variable "worker_npm_layer_arn" {
  description = "Prebuilt x86_64 Node.js 24 npm layer. Must provide /opt/nodejs/node_modules/npm/bin/npm-cli.js."
  type        = string
  default     = null

  validation {
    condition     = var.worker_npm_layer_arn == null ? true : can(regex("^arn:aws:lambda:${var.aws_region}:${var.aws_account_id}:layer:[A-Za-z0-9_-]+:[0-9]+$", var.worker_npm_layer_arn))
    error_message = "Use an npm layer version in this environment's account and region."
  }
}
variable "allowed_user_sub" {
  description = "Sub of the single administrator-created Cognito user. Obtain after initial user creation; never substitute local-user."
  type        = string
  default     = null

  validation {
    condition     = var.allowed_user_sub == null ? true : can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.allowed_user_sub))
    error_message = "allowed_user_sub must be a Cognito user UUID."
  }
}
variable "log_retention_days" {
  description = "CloudWatch retention for API and Worker logs."
  type        = number
  default     = 14
  validation {
    condition     = contains([7, 14, 30, 60, 90], var.log_retention_days)
    error_message = "Choose 7, 14, 30, 60, or 90 days."
  }
}
variable "budget_monthly_usd" {
  description = "Optional AWS monthly cost alert, separate from the OpenAI hard limit. Set together with budget_email."
  type        = number
  default     = null
  validation {
    condition     = var.budget_monthly_usd == null ? var.budget_email == null : var.budget_monthly_usd > 0 && var.budget_email != null
    error_message = "Set a positive AWS budget amount and a notification email together, or leave both unset."
  }
}
variable "budget_email" {
  description = "Optional AWS Budgets direct email destination. Monitoring/email notifications are free; this does not enable SNS."
  type        = string
  default     = null
  validation {
    condition     = var.budget_email == null ? true : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.budget_email))
    error_message = "Supply a valid notification email."
  }
}
variable "alarm_email" {
  description = "Separate optional SNS destination for CloudWatch operational alarms; SNS pricing/free-tier applies."
  type        = string
  default     = null
  validation {
    condition     = var.alarm_email == null ? true : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alarm_email))
    error_message = "Supply a valid operational-alarm notification email."
  }
}
