output "app_url" {
  description = "Public ALB URL for the application"
  value       = "${var.acm_certificate_arn != "" ? "https" : "http"}://${aws_lb.main.dns_name}"
}

output "alb_dns_name" {
  description = "Application Load Balancer DNS name"
  value       = aws_lb.main.dns_name
}

output "ecs_cluster_name" {
  description = "ECS Fargate cluster name"
  value       = aws_ecs_cluster.main.name
}

output "ecs_service_names" {
  description = "ECS service names"
  value = {
    backend  = aws_ecs_service.backend.name
    frontend = aws_ecs_service.frontend.name
  }
}

output "ecr_repository_urls" {
  description = "ECR repository URLs for pushing container images"
  value       = { for k, v in aws_ecr_repository.app : k => v.repository_url }
}

output "secret_arns" {
  description = "Secrets Manager ARNs (never secret values)"
  value = merge(
    { DATABASE_URL = aws_secretsmanager_secret.database_url.arn },
    { for k, v in aws_secretsmanager_secret.runtime_tokens : k => v.arn }
  )
}

output "rds_endpoint" {
  description = "Private RDS PostgreSQL endpoint"
  value       = aws_db_instance.main.endpoint
}

output "eks_cluster_name" {
  description = "AWS EKS Kubernetes cluster name (when active)"
  value       = length(aws_eks_cluster.main) > 0 ? aws_eks_cluster.main[0].name : null
}

output "monthly_budget_limit_usd" {
  description = "Configured monthly AWS cost budget limit in USD"
  value       = aws_budgets_budget.monthly_cost.limit_amount
}
