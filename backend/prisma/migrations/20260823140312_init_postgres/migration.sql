-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'EMPLOYEE',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" SERIAL NOT NULL,
    "product_name" TEXT NOT NULL,
    "sku" TEXT,
    "product_code" TEXT,
    "category" TEXT,
    "selling_price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "product_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "shipping_cost" DOUBLE PRECISION,
    "packaging_cost" DOUBLE PRECISION,
    "other_cost" DOUBLE PRECISION,
    "advertising_cost" DOUBLE PRECISION,
    "expected_return_cost" DOUBLE PRECISION,
    "commission" DOUBLE PRECISION,
    "current_stock" DOUBLE PRECISION,
    "minimum_stock" DOUBLE PRECISION,
    "supplier" TEXT,
    "restock_quantity" DOUBLE PRECISION,
    "last_restock_date" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_orders" (
    "id" SERIAL NOT NULL,
    "product_id" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "orders_count" INTEGER NOT NULL,
    "delivered_count" INTEGER,
    "returned_count" INTEGER,
    "notes" TEXT,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "data" TEXT NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_notes" (
    "id" SERIAL NOT NULL,
    "product_id" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "action_log" (
    "id" SERIAL NOT NULL,
    "product_id" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "task_type" TEXT,
    "priority" TEXT,
    "action_label" TEXT,
    "reason_text" TEXT,
    "not_completed_reason" TEXT,
    "not_completed_note" TEXT,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "action_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_reports" (
    "id" SERIAL NOT NULL,
    "date" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "report_text" TEXT NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "daily_task_target" INTEGER NOT NULL DEFAULT 10,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_assignments" (
    "id" SERIAL NOT NULL,
    "product_id" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_records" (
    "id" SERIAL NOT NULL,
    "date" TEXT NOT NULL,
    "product_id" INTEGER,
    "product_name" TEXT,
    "employee_id" INTEGER,
    "created_by_id" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "task_type" TEXT,
    "priority" TEXT,
    "title" TEXT,
    "details" TEXT,
    "manager_note" TEXT,
    "related_campaign" TEXT,
    "source" TEXT,
    "assignment_source" TEXT,
    "assigned_by" TEXT,
    "assigned_at" TIMESTAMP(3),
    "today" DOUBLE PRECISION,
    "yesterday" DOUBLE PRECISION,
    "diff" DOUBLE PRECISION,
    "due_date" TEXT,
    "execution_date" TEXT,
    "completed_at" TIMESTAMP(3),
    "not_completed_reason" TEXT,
    "not_completed_note" TEXT,
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by" TEXT,
    "cancel_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_activity_log" (
    "id" SERIAL NOT NULL,
    "date" TEXT NOT NULL,
    "task_id" INTEGER,
    "action_type" TEXT,
    "employee_to" INTEGER,
    "employee_from" INTEGER,
    "details_text" TEXT,
    "actor_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_activity_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_snapshots" (
    "id" SERIAL NOT NULL,
    "product_id" INTEGER NOT NULL,
    "product_name" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "opening_stock" DOUBLE PRECISION,
    "closing_stock" DOUBLE PRECISION NOT NULL,
    "units_out" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "stock_change" DOUBLE PRECISION,
    "movement_type" TEXT NOT NULL,
    "source" TEXT,
    "batch_id" INTEGER,
    "notes" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_movement_log" (
    "id" SERIAL NOT NULL,
    "product_id" INTEGER NOT NULL,
    "product_name" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "previous_qty" DOUBLE PRECISION,
    "new_qty" DOUBLE PRECISION,
    "diff" DOUBLE PRECISION,
    "movement_type" TEXT NOT NULL,
    "notes" TEXT,
    "updated_by" TEXT,
    "batch_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movement_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_column_mapping" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "productName" TEXT,
    "quantity" TEXT,
    "sku" TEXT,
    "warehouse" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_column_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_name_mapping" (
    "id" SERIAL NOT NULL,
    "excel_name_key" TEXT NOT NULL,
    "excel_name_original" TEXT NOT NULL,
    "product_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_name_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_import_batches" (
    "id" SERIAL NOT NULL,
    "date" TEXT NOT NULL,
    "filename" TEXT,
    "uploaded_by" TEXT,
    "total_rows" INTEGER,
    "matched_count" INTEGER,
    "unmatched_count" INTEGER,
    "duplicate_count" INTEGER,
    "invalid_count" INTEGER,
    "unmatched" TEXT,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "products_product_code_key" ON "products"("product_code");

-- CreateIndex
CREATE INDEX "products_active_idx" ON "products"("active");

-- CreateIndex
CREATE INDEX "products_product_name_idx" ON "products"("product_name");

-- CreateIndex
CREATE INDEX "products_sku_idx" ON "products"("sku");

-- CreateIndex
CREATE INDEX "daily_orders_date_idx" ON "daily_orders"("date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_orders_product_id_date_key" ON "daily_orders"("product_id", "date");

-- CreateIndex
CREATE INDEX "product_notes_product_id_idx" ON "product_notes"("product_id");

-- CreateIndex
CREATE INDEX "action_log_date_idx" ON "action_log"("date");

-- CreateIndex
CREATE UNIQUE INDEX "action_log_product_id_date_key" ON "action_log"("product_id", "date");

-- CreateIndex
CREATE INDEX "daily_reports_date_idx" ON "daily_reports"("date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_reports_date_type_key" ON "daily_reports"("date", "type");

-- CreateIndex
CREATE UNIQUE INDEX "team_members_name_key" ON "team_members"("name");

-- CreateIndex
CREATE INDEX "task_assignments_date_idx" ON "task_assignments"("date");

-- CreateIndex
CREATE INDEX "task_assignments_employee_id_idx" ON "task_assignments"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "task_assignments_product_id_date_key" ON "task_assignments"("product_id", "date");

-- CreateIndex
CREATE INDEX "task_records_date_idx" ON "task_records"("date");

-- CreateIndex
CREATE INDEX "task_records_employee_id_idx" ON "task_records"("employee_id");

-- CreateIndex
CREATE INDEX "task_records_product_id_idx" ON "task_records"("product_id");

-- CreateIndex
CREATE INDEX "task_records_status_idx" ON "task_records"("status");

-- CreateIndex
CREATE INDEX "task_activity_log_date_idx" ON "task_activity_log"("date");

-- CreateIndex
CREATE INDEX "task_activity_log_task_id_idx" ON "task_activity_log"("task_id");

-- CreateIndex
CREATE INDEX "inventory_snapshots_date_idx" ON "inventory_snapshots"("date");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_snapshots_product_id_date_key" ON "inventory_snapshots"("product_id", "date");

-- CreateIndex
CREATE INDEX "inventory_movement_log_date_idx" ON "inventory_movement_log"("date");

-- CreateIndex
CREATE INDEX "inventory_movement_log_product_id_idx" ON "inventory_movement_log"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_name_mapping_excel_name_key_key" ON "inventory_name_mapping"("excel_name_key");

-- CreateIndex
CREATE INDEX "inventory_import_batches_date_idx" ON "inventory_import_batches"("date");

-- AddForeignKey
ALTER TABLE "daily_orders" ADD CONSTRAINT "daily_orders_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_notes" ADD CONSTRAINT "product_notes_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_log" ADD CONSTRAINT "action_log_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_assignments" ADD CONSTRAINT "task_assignments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "team_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_records" ADD CONSTRAINT "task_records_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_records" ADD CONSTRAINT "task_records_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_records" ADD CONSTRAINT "task_records_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_activity_log" ADD CONSTRAINT "task_activity_log_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_activity_log" ADD CONSTRAINT "task_activity_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_snapshots" ADD CONSTRAINT "inventory_snapshots_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movement_log" ADD CONSTRAINT "inventory_movement_log_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
