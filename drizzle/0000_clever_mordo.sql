CREATE TABLE IF NOT EXISTS `inventory` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`category` text,
	`quantity` real DEFAULT 0 NOT NULL,
	`unit` text DEFAULT 'pcs' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `item_aliases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scanned_name` text NOT NULL,
	`target_name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `item_aliases_scanned_name_unique` ON `item_aliases` (`scanned_name`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `recipe_ingredients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recipe_id` integer NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`amount` real NOT NULL,
	`unit` text NOT NULL,
	`name` text NOT NULL,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `recipe_steps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recipe_id` integer NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`step_text` text NOT NULL,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `recipes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`servings` integer,
	`duration` integer,
	`difficulty` text,
	`habits` text,
	`categories` text,
	`ingredients` text,
	`instructions` text
);
