package store

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"time"

	"github.com/jackc/pgx/v5"

	"gymbro/internal/apiclient"
	"gymbro/internal/apperr"
)

const selectProgram = `SELECT id::text, name, entries, updated_at FROM workout_programs`

func scanProgram(row pgx.Row) (apiclient.Program, error) {
	var p apiclient.Program
	err := row.Scan(&p.ID, &p.Name, &p.Entries, &p.UpdatedAt)
	p.UpdatedAt = p.UpdatedAt.UTC()
	return p, err
}

func (s *Store) ListPrograms(ctx context.Context, userID int64) (apiclient.ListProgramsResponse, error) {
	resp := apiclient.ListProgramsResponse{Programs: []apiclient.Program{}}
	rows, err := s.pool.Query(ctx, selectProgram+` WHERE user_id=$1 ORDER BY name COLLATE "C", id`, userID)
	if err != nil {
		return resp, fmt.Errorf("list programs: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		p, err := scanProgram(rows)
		if err != nil {
			return resp, fmt.Errorf("scan program: %w", err)
		}
		resp.Programs = append(resp.Programs, p)
	}
	return resp, rows.Err()
}

// CreateProgram locks replays without rewriting them; foreign IDs are never exposed.
func (s *Store) CreateProgram(ctx context.Context, userID int64, req apiclient.CreateProgramRequest) (apiclient.Program, bool, error) {
	var p apiclient.Program
	created := false
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		for {
			var err error
			p, err = scanProgram(tx.QueryRow(ctx, `INSERT INTO workout_programs (id,user_id,name,entries) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING RETURNING id::text,name,entries,updated_at`, req.ID, userID, req.Name, req.Entries))
			if err == nil {
				created = true
				return nil
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return fmt.Errorf("create program: %w", err)
			}
			p, err = scanProgram(tx.QueryRow(ctx, selectProgram+` WHERE id=$1 FOR UPDATE`, req.ID))
			if errors.Is(err, pgx.ErrNoRows) {
				continue
			}
			if err != nil {
				return fmt.Errorf("lock program replay: %w", err)
			}
			var owner int64
			if err = tx.QueryRow(ctx, `SELECT user_id FROM workout_programs WHERE id=$1`, req.ID).Scan(&owner); err != nil {
				return err
			}
			if owner != userID || p.Name != req.Name || !reflect.DeepEqual(p.Entries, req.Entries) {
				return apperr.ErrConflict
			}
			return nil
		}
	})
	if err != nil {
		return apiclient.Program{}, false, err
	}
	return p, created, nil
}

func checkProgramRevision(ctx context.Context, tx pgx.Tx, userID int64, id string, expected time.Time) error {
	var revision time.Time
	err := tx.QueryRow(ctx, `SELECT updated_at FROM workout_programs WHERE id=$1 AND user_id=$2 FOR UPDATE`, id, userID).Scan(&revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.ErrProgramNotFound
	}
	if err != nil {
		return fmt.Errorf("lock program: %w", err)
	}
	if !revision.Equal(expected) {
		return apperr.ErrConflict
	}
	return nil
}

func (s *Store) UpdateProgram(ctx context.Context, userID int64, id string, req apiclient.UpdateProgramRequest) (apiclient.Program, error) {
	var p apiclient.Program
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		if err := checkProgramRevision(ctx, tx, userID, id, req.ExpectedUpdatedAt); err != nil {
			return err
		}
		var err error
		p, err = scanProgram(tx.QueryRow(ctx, `UPDATE workout_programs SET name=$3, entries=$4, updated_at=GREATEST(clock_timestamp(),updated_at+interval '1 microsecond') WHERE id=$1 AND user_id=$2 RETURNING id::text,name,entries,updated_at`, id, userID, req.Name, req.Entries))
		return err
	})
	if err != nil {
		return apiclient.Program{}, err
	}
	return p, nil
}

func (s *Store) DeleteProgram(ctx context.Context, userID int64, id string, expected time.Time) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		if err := checkProgramRevision(ctx, tx, userID, id, expected); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `DELETE FROM workout_programs WHERE id=$1 AND user_id=$2`, id, userID)
		return err
	})
}
