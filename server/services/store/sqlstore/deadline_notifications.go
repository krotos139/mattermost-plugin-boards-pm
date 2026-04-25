// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package sqlstore

import (
	sq "github.com/Masterminds/squirrel"

	"github.com/mattermost/mattermost-plugin-boards/server/model"
	"github.com/mattermost/mattermost-plugin-boards/server/utils"
)

// isDeadlineNotificationSent reports whether a deadline DM has already been sent
// for the given (card, property, deadline_at) tuple. The deadline ticker calls
// this to avoid double-notifying on every tick.
func (s *SQLStore) isDeadlineNotificationSent(db sq.BaseRunner, cardID string, propertyID string, deadlineAt int64) (bool, error) {
	query := s.getQueryBuilder(db).
		Select("1").
		From(s.tablePrefix + "deadline_notifications").
		Where(sq.Eq{
			"card_id":     cardID,
			"property_id": propertyID,
			"deadline_at": deadlineAt,
		}).
		Limit(1)

	rows, err := query.Query()
	if err != nil {
		return false, err
	}
	defer s.CloseRows(rows)

	return rows.Next(), nil
}

// markDeadlineNotificationSent records that a deadline DM has been sent for the
// given (card, property, deadline_at) tuple. Idempotent: a duplicate write
// (e.g. from a second plugin instance) is silently ignored.
func (s *SQLStore) markDeadlineNotificationSent(db sq.BaseRunner, cardID string, propertyID string, deadlineAt int64) error {
	query := s.getQueryBuilder(db).
		Insert(s.tablePrefix + "deadline_notifications").
		Columns("card_id", "property_id", "deadline_at", "notified_at").
		Values(cardID, propertyID, deadlineAt, utils.GetMillis())

	if s.dbType == model.MysqlDBType {
		query = query.Suffix("ON DUPLICATE KEY UPDATE notified_at = notified_at")
	} else {
		query = query.Suffix("ON CONFLICT (card_id, property_id, deadline_at) DO NOTHING")
	}

	if _, err := query.Exec(); err != nil {
		return err
	}
	return nil
}
