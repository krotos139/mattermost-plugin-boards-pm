CREATE TABLE IF NOT EXISTS {{.prefix}}deadline_notifications (
	card_id VARCHAR(36) NOT NULL,
	property_id VARCHAR(36) NOT NULL,
	deadline_at BIGINT NOT NULL,
	notified_at BIGINT NOT NULL,
	PRIMARY KEY (card_id, property_id, deadline_at)
) {{if .mysql}}DEFAULT CHARACTER SET utf8mb4{{end}};
