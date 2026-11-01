terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}
variable "name" { type = string }

resource "aws_dynamodb_table" "jobs" {
  name                        = var.name
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "PK"
  range_key                   = "SK"
  deletion_protection_enabled = true

  attribute {
    name = "PK"
    type = "S"
  }
  attribute {
    name = "SK"
    type = "S"
  }
  server_side_encryption {
    enabled = true
  }
  point_in_time_recovery {
    enabled = true
  }
}

output "name" { value = aws_dynamodb_table.jobs.name }
output "arn" { value = aws_dynamodb_table.jobs.arn }
