-- AI Operator — execution/automation layer (config, rules, exceptions, per-product settings, campaign tags, decision log).
-- HAND-WRITTEN SQL (never `prisma migrate dev`/`diff` against this shared production database — standing shadow-database incident rule).
-- Purely additive: six brand-new tables, zero ALTER/DROP/RENAME on any existing table or column, no foreign keys to existing tables.
-- Run once through `prisma migrate deploy`.

CREATE TABLE "amb_operator_config" (
    "id" SERIAL NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'GLOBAL',
    "mode" TEXT NOT NULL DEFAULT 'SHADOW',
    "emergency_stop" BOOLEAN NOT NULL DEFAULT false,
    "emergency_reason" TEXT,
    "emergency_by_id" INTEGER,
    "emergency_at" TIMESTAMP(3),
    "limits_json" TEXT,
    "cooldowns_json" TEXT,
    "schedule_json" TEXT,
    "updated_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "amb_operator_config_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "amb_operator_config_scope_key" ON "amb_operator_config"("scope");

CREATE TABLE "amb_operator_rules" (
    "id" SERIAL NOT NULL,
    "rule_uuid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "store_id" TEXT,
    "scope_json" TEXT,
    "window" TEXT NOT NULL DEFAULT 'today',
    "conditions_json" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "action_params_json" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'SHADOW',
    "cooldown_hours" INTEGER NOT NULL DEFAULT 24,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "source" TEXT NOT NULL DEFAULT 'BUILDER',
    "nl_text" TEXT,
    "validation_json" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "amb_operator_rules_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "amb_operator_rules_rule_uuid_key" ON "amb_operator_rules"("rule_uuid");
CREATE INDEX "amb_operator_rules_enabled_store_id_idx" ON "amb_operator_rules"("enabled", "store_id");

CREATE TABLE "amb_operator_exceptions" (
    "id" SERIAL NOT NULL,
    "store_id" TEXT,
    "scope_type" TEXT NOT NULL,
    "scope_id" TEXT NOT NULL,
    "scope_label" TEXT,
    "types_json" TEXT NOT NULL,
    "reason" TEXT,
    "expires_at" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "amb_operator_exceptions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "amb_operator_exceptions_scope_type_scope_id_active_idx" ON "amb_operator_exceptions"("scope_type", "scope_id", "active");

CREATE TABLE "amb_operator_product_config" (
    "id" SERIAL NOT NULL,
    "product_id" INTEGER NOT NULL,
    "store_id" TEXT NOT NULL,
    "product_key" TEXT,
    "target_cpa" DOUBLE PRECISION,
    "max_cpa" DOUBLE PRECISION,
    "hard_stop_cpa" DOUBLE PRECISION,
    "min_profit" DOUBLE PRECISION,
    "min_margin_pct" DOUBLE PRECISION,
    "min_stock" DOUBLE PRECISION,
    "notes" TEXT,
    "updated_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "amb_operator_product_config_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "amb_operator_product_config_product_id_store_id_key" ON "amb_operator_product_config"("product_id", "store_id");

CREATE TABLE "amb_operator_campaign_tags" (
    "id" SERIAL NOT NULL,
    "ad_account_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "store_id" TEXT,
    "product_id" INTEGER,
    "tag" TEXT NOT NULL,
    "testing_json" TEXT,
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "amb_operator_campaign_tags_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "amb_operator_campaign_tags_ad_account_id_campaign_id_key" ON "amb_operator_campaign_tags"("ad_account_id", "campaign_id");

CREATE TABLE "amb_operator_decisions" (
    "id" SERIAL NOT NULL,
    "decision_key" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "product_id" INTEGER,
    "amb_product_id" INTEGER,
    "ad_account_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "campaign_name" TEXT,
    "action" TEXT NOT NULL,
    "rule_id" INTEGER,
    "rule_name" TEXT,
    "mode_at_decision" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SHADOW',
    "confidence" TEXT NOT NULL DEFAULT 'LOW',
    "blocked_codes_json" TEXT,
    "evidence_json" TEXT,
    "why_json" TEXT,
    "params_json" TEXT,
    "before_json" TEXT,
    "after_json" TEXT,
    "rollback_json" TEXT,
    "advisor_rec_id" TEXT,
    "advisor_plan_version" INTEGER,
    "amb_recommendation_id" INTEGER,
    "amb_action_id" INTEGER,
    "approval_source" TEXT,
    "approved_by_id" INTEGER,
    "approved_at" TIMESTAMP(3),
    "executed_at" TIMESTAMP(3),
    "verified_at" TIMESTAMP(3),
    "verify_json" TEXT,
    "error" TEXT,
    "outcome_json" TEXT,
    "shadow_json" TEXT,
    "snoozed_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "amb_operator_decisions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "amb_operator_decisions_decision_key_key" ON "amb_operator_decisions"("decision_key");
CREATE INDEX "amb_operator_decisions_store_id_status_idx" ON "amb_operator_decisions"("store_id", "status");
CREATE INDEX "amb_operator_decisions_campaign_id_action_created_at_idx" ON "amb_operator_decisions"("campaign_id", "action", "created_at");
CREATE INDEX "amb_operator_decisions_created_at_idx" ON "amb_operator_decisions"("created_at");
