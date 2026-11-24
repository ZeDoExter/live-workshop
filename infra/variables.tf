variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Resource name prefix and Project tag"
  type        = string
  default     = "live-workshop"

  validation {
    condition     = length(var.project_name) <= 20 && can(regex("^[a-z]([a-z0-9]|-[a-z0-9])*$", var.project_name))
    error_message = "project_name must be 1-20 chars, start with [a-z], end with [a-z0-9], and use only lowercase letters, digits, or single hyphens."
  }
}

variable "vpc_cidr" {
  description = "CIDR block for the dedicated VPC"
  type        = string
  default     = "10.20.0.0/16"
}

variable "demo_enabled" {
  description = "Owner kill switch: scales ECS services (1/0) and sets backend DEMO_ENABLED"
  type        = bool
  default     = true
}

variable "acm_certificate_arn" {
  description = "Optional ACM certificate ARN; enables HTTPS (443) and HTTP->HTTPS redirect"
  type        = string
  default     = ""
}

variable "backend_image_tag" {
  description = "ECR image tag for the backend service"
  type        = string
  default     = "latest"
}

variable "frontend_image_tag" {
  description = "ECR image tag for the frontend service"
  type        = string
  default     = "latest"
}

variable "backend_cpu" {
  description = "Fargate CPU units for the backend task"
  type        = number
  default     = 256
}

variable "backend_memory" {
  description = "Fargate memory (MiB) for the backend task"
  type        = number
  default     = 512
}

variable "frontend_cpu" {
  description = "Fargate CPU units for the frontend task"
  type        = number
  default     = 256
}

variable "frontend_memory" {
  description = "Fargate memory (MiB) for the frontend task"
  type        = number
  default     = 512
}

variable "db_instance_class" {
  description = "RDS PostgreSQL instance class"
  type        = string
  default     = "db.t4g.micro"
}

variable "db_name" {
  description = "Initial PostgreSQL database name"
  type        = string
  default     = "workshop"
}

variable "db_username" {
  description = "PostgreSQL master username"
  type        = string
  default     = "workshop_app"
}

variable "db_skip_final_snapshot" {
  description = "Skip final RDS snapshot on destroy (set false for production persistence)"
  type        = bool
  default     = true
}

variable "log_retention_days" {
  description = "CloudWatch log retention in days"
  type        = number
  default     = 14
}

variable "budget_limit_usd" {
  description = "Monthly AWS cost budget cap in USD"
  type        = string
  default     = "10.0"
}

variable "budget_alert_emails" {
  description = "Optional email addresses notified at 80% and 100% of the 10 USD monthly budget"
  type        = list(string)
  default     = []
}

variable "enable_eks" {
  description = "Provision AWS EKS Kubernetes control plane for K8s workloads"
  type        = bool
  default     = true
}
