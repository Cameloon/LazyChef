CREATE TABLE IF NOT EXISTS `allergens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ingredient_name` text NOT NULL,
	`has_lactose` integer DEFAULT 0 NOT NULL,
	`has_gluten` integer DEFAULT 0 NOT NULL,
	`last_checked` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `allergens_ingredient_name_unique` ON `allergens` (`ingredient_name`);