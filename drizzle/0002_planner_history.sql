CREATE TABLE IF NOT EXISTS `planner_generation_meals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`generation_id` integer NOT NULL,
	`day_number` integer NOT NULL,
	`meal_index` integer NOT NULL,
	`meal_type` text NOT NULL,
	`name` text NOT NULL,
	`time` text NOT NULL,
	`missing` text DEFAULT '[]' NOT NULL,
	`diet` text,
	`source` text,
	`locked` integer DEFAULT false NOT NULL,
	`recipe_title` text,
	FOREIGN KEY (`generation_id`) REFERENCES `planner_generations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `planner_generations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text NOT NULL,
	`days` integer NOT NULL,
	`diet` text NOT NULL,
	`generation_mode` text NOT NULL,
	`source_screen` text DEFAULT 'planner' NOT NULL
);
