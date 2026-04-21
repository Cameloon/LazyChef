CREATE TABLE IF NOT EXISTS `shopping_lists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `shopping_list_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`list_id` integer NOT NULL,
	`name` text NOT NULL,
	`quantity` real DEFAULT 1 NOT NULL,
	`unit` text DEFAULT 'pcs' NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `shopping_lists`(`id`) ON UPDATE no action ON DELETE cascade
);
