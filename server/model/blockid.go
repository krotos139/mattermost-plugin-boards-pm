// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package model

import (
	"fmt"

	"github.com/mattermost/mattermost-plugin-boards/server/utils"

	"github.com/mattermost/mattermost/server/public/shared/mlog"
)

// GenerateBlockIDs generates new IDs for all the blocks of the list,
// keeping consistent any references that other blocks would made to
// the original IDs, so a tree of blocks can get new IDs and maintain
// its shape.
func GenerateBlockIDs(blocks []*Block, logger mlog.LoggerIFace) []*Block {
	blockIDs := map[string]BlockType{}
	referenceIDs := map[string]bool{}
	for _, block := range blocks {
		if _, ok := blockIDs[block.ID]; !ok {
			blockIDs[block.ID] = block.Type
		}

		if _, ok := referenceIDs[block.BoardID]; !ok {
			referenceIDs[block.BoardID] = true
		}
		if _, ok := referenceIDs[block.ParentID]; !ok {
			referenceIDs[block.ParentID] = true
		}

		if _, ok := block.Fields["contentOrder"]; ok {
			contentOrder, typeOk := block.Fields["contentOrder"].([]interface{})
			if !typeOk {
				logger.Warn(
					"type assertion failed for content order when saving reference block IDs",
					mlog.String("blockID", block.ID),
					mlog.String("actionType", fmt.Sprintf("%T", block.Fields["contentOrder"])),
					mlog.String("expectedType", "[]interface{}"),
					mlog.String("contentOrder", fmt.Sprintf("%v", block.Fields["contentOrder"])),
				)
				continue
			}

			for _, blockID := range contentOrder {
				switch v := blockID.(type) {
				case []interface{}:
					for _, columnBlockID := range v {
						referenceIDs[columnBlockID.(string)] = true
					}
				case string:
					referenceIDs[v] = true
				default:
				}
			}
		}

		if _, ok := block.Fields["defaultTemplateId"]; ok {
			defaultTemplateID, typeOk := block.Fields["defaultTemplateId"].(string)
			if !typeOk {
				logger.Warn(
					"type assertion failed for default template ID when saving reference block IDs",
					mlog.String("blockID", block.ID),
					mlog.String("actionType", fmt.Sprintf("%T", block.Fields["defaultTemplateId"])),
					mlog.String("expectedType", "string"),
					mlog.String("defaultTemplateId", fmt.Sprintf("%v", block.Fields["defaultTemplateId"])),
				)
				continue
			}
			referenceIDs[defaultTemplateID] = true
		}
	}

	// Pre-generate a new ID for every block in the batch. Previously the map
	// only held entries for blocks that were *referenced* by another block's
	// BoardID/ParentID/contentOrder/cardOrder/defaultTemplateId. That was
	// fine for the original use cases but missed card-id values stored
	// inside per-card property values (Task / Multi task properties hold
	// card IDs). To remap those reliably we need the full old->new table
	// for every card-id that appears anywhere in the batch, not just the
	// ones surfaced by the structural reference scan above.
	newIDs := map[string]string{}
	for id, blockType := range blockIDs {
		newIDs[id] = utils.NewID(BlockType2IDType(blockType))
	}

	getExistingOrOldID := func(id string) string {
		if existingID, ok := newIDs[id]; ok {
			return existingID
		}
		return id
	}

	getExistingOrNewID := func(id string) string {
		if existingID, ok := newIDs[id]; ok {
			return existingID
		}
		return utils.NewID(BlockType2IDType(blockIDs[id]))
	}

	newBlocks := make([]*Block, len(blocks))
	for i, block := range blocks {
		block.ID = getExistingOrNewID(block.ID)
		block.BoardID = getExistingOrOldID(block.BoardID)
		block.ParentID = getExistingOrOldID(block.ParentID)

		blockMod := block
		if _, ok := blockMod.Fields["contentOrder"]; ok {
			fixFieldIDs(blockMod, "contentOrder", getExistingOrOldID, logger)
		}

		if _, ok := blockMod.Fields["cardOrder"]; ok {
			fixFieldIDs(blockMod, "cardOrder", getExistingOrOldID, logger)
		}

		if _, ok := blockMod.Fields["defaultTemplateId"]; ok {
			defaultTemplateID, typeOk := blockMod.Fields["defaultTemplateId"].(string)
			if !typeOk {
				logger.Warn(
					"type assertion failed for default template ID when saving reference block IDs",
					mlog.String("blockID", blockMod.ID),
					mlog.String("actionType", fmt.Sprintf("%T", blockMod.Fields["defaultTemplateId"])),
					mlog.String("expectedType", "string"),
					mlog.String("defaultTemplateId", fmt.Sprintf("%v", blockMod.Fields["defaultTemplateId"])),
				)
			} else {
				blockMod.Fields["defaultTemplateId"] = getExistingOrOldID(defaultTemplateID)
			}
		}

		// Remap any per-card property value that references another block
		// in this batch. Task properties store a single card id (string);
		// Multi-task properties store an array of card ids ([]interface{}
		// of strings after JSON unmarshal). We walk the properties map and
		// substitute any string equal to a known old block id with its new
		// id. We don't need to know which property is type=task/multiTask:
		// the substitution only fires when the value actually matches a
		// block id we generated above, so non-task properties (select
		// option ids, person user ids, free text, dates) are left alone
		// because their values are never block ids. Without this the
		// imported board keeps stale card-id references in Task / Multi
		// task fields, breaking Timeline view dependency arrows and the
		// task-selector display.
		if blockMod.Type == TypeCard {
			remapCardPropertyIDs(blockMod, newIDs)
		}

		newBlocks[i] = blockMod
	}

	return newBlocks
}

// remapCardPropertyIDs rewrites string and []string property values inside a
// card block's `properties` map when they equal a known old block id. The
// substitution is keyed strictly on `oldToNew` membership, so non-card-id
// property values (select option ids, user ids, dates, free text) pass
// through unchanged.
func remapCardPropertyIDs(block *Block, oldToNew map[string]string) {
	props, ok := block.Fields["properties"].(map[string]interface{})
	if !ok {
		return
	}
	for key, value := range props {
		switch v := value.(type) {
		case string:
			if newID, found := oldToNew[v]; found {
				props[key] = newID
			}
		case []interface{}:
			rewritten := false
			out := make([]interface{}, len(v))
			for j, item := range v {
				if s, isStr := item.(string); isStr {
					if newID, found := oldToNew[s]; found {
						out[j] = newID
						rewritten = true
						continue
					}
				}
				out[j] = item
			}
			if rewritten {
				props[key] = out
			}
		}
	}
}

func fixFieldIDs(block *Block, fieldName string, getExistingOrOldID func(string) string, logger mlog.LoggerIFace) {
	field, typeOk := block.Fields[fieldName].([]interface{})
	if !typeOk {
		logger.Warn(
			"type assertion failed for JSON field when setting new block IDs",
			mlog.String("blockID", block.ID),
			mlog.String("fieldName", fieldName),
			mlog.String("actionType", fmt.Sprintf("%T", block.Fields[fieldName])),
			mlog.String("expectedType", "[]interface{}"),
			mlog.String("value", fmt.Sprintf("%v", block.Fields[fieldName])),
		)
	} else {
		for j := range field {
			switch v := field[j].(type) {
			case string:
				field[j] = getExistingOrOldID(v)
			case []interface{}:
				subOrder := field[j].([]interface{})
				for k := range v {
					subOrder[k] = getExistingOrOldID(v[k].(string))
				}
			}
		}
	}
}
