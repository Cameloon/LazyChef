CREATE TABLE IF NOT EXISTS `app_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`intolerances` text DEFAULT 'none' NOT NULL,
	`lactose_intolerance` integer DEFAULT 0 NOT NULL,
	`gluten_intolerance` integer DEFAULT 0 NOT NULL,
	`eating_habit` text DEFAULT 'all' NOT NULL,
	`default_servings` integer DEFAULT 1 NOT NULL,
	`language` text DEFAULT 'en' NOT NULL
);
