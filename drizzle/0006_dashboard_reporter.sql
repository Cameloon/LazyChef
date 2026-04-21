CREATE TABLE IF NOT EXISTS `inventory_movements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_name` text NOT NULL,
	`delta` real NOT NULL,
	`unit` text DEFAULT 'pcs' NOT NULL,
	`event_type` text DEFAULT 'purchase' NOT NULL,
	`created_at` text NOT NULL
);
