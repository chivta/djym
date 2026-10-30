// Package state is the bot's small SQLite store: saved workout IDs, first-save
// times, and the draft cache's write-through copy, all of which outlive restarts.
package state

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	_ "modernc.org/sqlite" // pure-Go driver, registers "sqlite"
)

// dsnOptions: wait on a locked file and use WAL.
const dsnOptions = "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)"

// schema is idempotent, so it runs on every startup.
const schema = `CREATE TABLE IF NOT EXISTS first_saves (
	chat_id         INTEGER NOT NULL,
	message_id      INTEGER NOT NULL,
	first_saved_at  INTEGER NOT NULL, -- unix seconds
	PRIMARY KEY (chat_id, message_id)
);
CREATE TABLE IF NOT EXISTS saved_workouts (
	chat_id     INTEGER NOT NULL,
	message_id  INTEGER NOT NULL,
	workout_id  INTEGER NOT NULL,
	PRIMARY KEY (chat_id, message_id)
);
CREATE TABLE IF NOT EXISTS drafts (
	chat_id     INTEGER NOT NULL,
	message_id  INTEGER NOT NULL,
	touched_at  INTEGER NOT NULL, -- unix seconds of the last touch
	data        TEXT    NOT NULL, -- opaque to this package (the bot's JSON)
	PRIMARY KEY (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS drafts_chat_touched ON drafts (chat_id, touched_at)`

const (
	selectFirstSave = `SELECT first_saved_at FROM first_saves WHERE chat_id = ? AND message_id = ?`
	// DO NOTHING: the first save time is never overwritten.
	insertFirstSave = `INSERT INTO first_saves (chat_id, message_id, first_saved_at) VALUES (?, ?, ?)
		ON CONFLICT (chat_id, message_id) DO NOTHING`
)

const (
	selectDraft = `SELECT touched_at, data FROM drafts WHERE chat_id = ? AND message_id = ?`
	upsertDraft = `INSERT INTO drafts (chat_id, message_id, touched_at, data) VALUES (?, ?, ?, ?)
		ON CONFLICT (chat_id, message_id) DO UPDATE SET touched_at = excluded.touched_at, data = excluded.data`
	selectLatestDraft = `SELECT message_id, touched_at, data FROM drafts WHERE chat_id = ? AND touched_at >= ?
		ORDER BY touched_at DESC, message_id DESC LIMIT 1`
	deleteDraftsBefore = `DELETE FROM drafts WHERE touched_at < ?`
	deleteDraft        = `DELETE FROM drafts WHERE chat_id = ? AND message_id = ?`
)

// Store holds saved workout targets, first-save times, and cached drafts.
type Store struct {
	db *sql.DB
}

// Open opens (creating if needed) the SQLite file at path and ensures the schema.
func Open(ctx context.Context, path string) (*Store, error) {
	db, err := sql.Open("sqlite", path+dsnOptions)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// One writer: a single connection avoids SQLITE_BUSY between our own calls.
	db.SetMaxOpenConns(1)
	_, err = db.ExecContext(ctx, schema)
	if err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("create schema: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// FirstSave returns when the message was first saved; ok is false if never.
func (s *Store) FirstSave(ctx context.Context, chatID int64, msgID int) (t time.Time, ok bool, err error) {
	var unix int64
	err = s.db.QueryRowContext(ctx, selectFirstSave, chatID, msgID).Scan(&unix)
	if errors.Is(err, sql.ErrNoRows) {
		return time.Time{}, false, nil
	}
	if err != nil {
		return time.Time{}, false, fmt.Errorf("select first save: %w", err)
	}
	return time.Unix(unix, 0), true, nil
}

// SetFirstSave records t for the message unless a time is already stored.
func (s *Store) SetFirstSave(ctx context.Context, chatID int64, msgID int, t time.Time) error {
	_, err := s.db.ExecContext(ctx, insertFirstSave, chatID, msgID, t.Unix())
	if err != nil {
		return fmt.Errorf("insert first save: %w", err)
	}
	return nil
}

// WorkoutID returns the durable API target, independent of draft expiration.
func (s *Store) WorkoutID(ctx context.Context, chatID int64, msgID int) (int64, error) {
	var id int64
	err := s.db.QueryRowContext(ctx, `SELECT workout_id FROM saved_workouts WHERE chat_id=? AND message_id=?`, chatID, msgID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("select saved workout: %w", err)
	}
	return id, nil
}

// SetWorkoutSave records the API target and first-save time atomically.
func (s *Store) SetWorkoutSave(ctx context.Context, chatID int64, msgID int, id int64, firstSaved time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, insertFirstSave, chatID, msgID, firstSaved.Unix()); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO saved_workouts (chat_id,message_id,workout_id) VALUES (?,?,?)
 ON CONFLICT (chat_id,message_id) DO UPDATE SET workout_id=excluded.workout_id`, chatID, msgID, id); err != nil {
		return err
	}
	return tx.Commit()
}

// Draft is a stored draft: an opaque payload and the time it was last touched.
type Draft struct {
	Data    string
	Touched time.Time
}

// LoadDraft returns the draft of the message; ok is false if none is stored.
func (s *Store) LoadDraft(ctx context.Context, chatID int64, msgID int) (d Draft, ok bool, err error) {
	var unix int64
	err = s.db.QueryRowContext(ctx, selectDraft, chatID, msgID).Scan(&unix, &d.Data)
	if errors.Is(err, sql.ErrNoRows) {
		return Draft{}, false, nil
	}
	if err != nil {
		return Draft{}, false, fmt.Errorf("select draft: %w", err)
	}
	d.Touched = time.Unix(unix, 0)
	return d, true, nil
}

// SaveDraft inserts or replaces the draft of the message.
func (s *Store) SaveDraft(ctx context.Context, chatID int64, msgID int, d Draft) error {
	_, err := s.db.ExecContext(ctx, upsertDraft, chatID, msgID, d.Touched.Unix(), d.Data)
	if err != nil {
		return fmt.Errorf("upsert draft: %w", err)
	}
	return nil
}

// LatestDraft returns the chat's most recently touched draft not touched
// before notBefore; ok is false if there is none.
func (s *Store) LatestDraft(ctx context.Context, chatID int64, notBefore time.Time) (msgID int, d Draft, ok bool, err error) {
	var unix int64
	err = s.db.QueryRowContext(ctx, selectLatestDraft, chatID, notBefore.Unix()).Scan(&msgID, &unix, &d.Data)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, Draft{}, false, nil
	}
	if err != nil {
		return 0, Draft{}, false, fmt.Errorf("select latest draft: %w", err)
	}
	d.Touched = time.Unix(unix, 0)
	return msgID, d, true, nil
}

// DeleteDraftsBefore removes every draft last touched before t.
func (s *Store) DeleteDraftsBefore(ctx context.Context, t time.Time) error {
	_, err := s.db.ExecContext(ctx, deleteDraftsBefore, t.Unix())
	if err != nil {
		return fmt.Errorf("delete expired drafts: %w", err)
	}
	return nil
}

// DeleteDraft removes the draft of the message, if any.
func (s *Store) DeleteDraft(ctx context.Context, chatID int64, msgID int) error {
	_, err := s.db.ExecContext(ctx, deleteDraft, chatID, msgID)
	if err != nil {
		return fmt.Errorf("delete draft: %w", err)
	}
	return nil
}
