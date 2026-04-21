CREATE TABLE IF NOT EXISTS `planned_recipe_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`position` integer NOT NULL,
	`recipe_id` integer NOT NULL,
	`servings` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade
);
