package store

import (
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"gymbro/internal/apiclient"
	"gymbro/internal/apperr"
)

func programRequest(id, name string) apiclient.CreateProgramRequest {
	reps := 8
	return apiclient.CreateProgramRequest{ID: id, Name: name, Entries: []apiclient.ProgramEntry{{Name: "Bench", SetCount: 3, TargetReps: &reps}, {Name: "Dips", SetCount: 2}}}
}

func TestProgramCRUDPostgres(t *testing.T) {
	s, pool, ctx := localMobileStore(t)
	user := newTestUser(t, ctx, pool)
	foreign := newTestUser(t, ctx, pool)
	req := programRequest("cc000000-0000-4000-8000-000000000001", "Push Day")
	p, created, err := s.CreateProgram(ctx, user, req)
	if err != nil || !created || p.ID != req.ID || !reflect.DeepEqual(p.Entries, req.Entries) || p.UpdatedAt.Location() != time.UTC {
		t.Fatalf("create: %+v %v %v", p, created, err)
	}
	replay, created, err := s.CreateProgram(ctx, user, req)
	if err != nil || created || !reflect.DeepEqual(p, replay) {
		t.Fatalf("replay: %+v %v %v", replay, created, err)
	}
	different := req
	different.Entries = append([]apiclient.ProgramEntry{}, req.Entries...)
	different.Entries[0], different.Entries[1] = different.Entries[1], different.Entries[0]
	if _, _, err := s.CreateProgram(ctx, user, different); !errors.Is(err, apperr.ErrConflict) {
		t.Fatalf("differing replay: %v", err)
	}
	if _, _, err := s.CreateProgram(ctx, foreign, req); !errors.Is(err, apperr.ErrConflict) {
		t.Fatalf("foreign replay: %v", err)
	}
	duplicate := req
	duplicate.ID = "cc000000-0000-4000-8000-000000000002"
	duplicate.Name = "  PUSH   day "
	if _, _, err := s.CreateProgram(ctx, user, duplicate); !errors.Is(err, apperr.ErrConflict) {
		t.Fatalf("duplicate name: %v", err)
	}
	if _, created, err := s.CreateProgram(ctx, foreign, duplicate); err != nil || !created {
		t.Fatalf("other account name: %v", err)
	}
	second := programRequest("cc000000-0000-4000-8000-000000000003", "Arms")
	if _, _, err := s.CreateProgram(ctx, user, second); err != nil {
		t.Fatal(err)
	}
	list, err := s.ListPrograms(ctx, user)
	if err != nil || len(list.Programs) != 2 || list.Programs[0].ID != second.ID || list.Programs[1].ID != p.ID {
		t.Fatalf("snapshot: %+v %v", list, err)
	}
	edit := apiclient.UpdateProgramRequest{Name: "Arms", Entries: req.Entries, ExpectedUpdatedAt: p.UpdatedAt}
	if _, err := s.UpdateProgram(ctx, user, p.ID, edit); !errors.Is(err, apperr.ErrConflict) {
		t.Fatalf("rename duplicate: %v", err)
	}
	edit.Name = "Push revised"
	if _, err := s.UpdateProgram(ctx, foreign, p.ID, edit); !errors.Is(err, apperr.ErrProgramNotFound) {
		t.Fatalf("foreign update: %v", err)
	}
	if err := s.DeleteProgram(ctx, foreign, p.ID, p.UpdatedAt); !errors.Is(err, apperr.ErrProgramNotFound) {
		t.Fatalf("foreign delete: %v", err)
	}
	updated, err := s.UpdateProgram(ctx, user, p.ID, edit)
	if err != nil || !updated.UpdatedAt.After(p.UpdatedAt) || updated.Name != edit.Name {
		t.Fatalf("update: %+v %v", updated, err)
	}
	if _, err := s.UpdateProgram(ctx, user, p.ID, edit); !errors.Is(err, apperr.ErrConflict) {
		t.Fatalf("stale update: %v", err)
	}
	if err := s.DeleteProgram(ctx, user, p.ID, p.UpdatedAt); !errors.Is(err, apperr.ErrConflict) {
		t.Fatalf("stale delete: %v", err)
	}
	if err := s.DeleteProgram(ctx, user, p.ID, updated.UpdatedAt); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteProgram(ctx, user, p.ID, updated.UpdatedAt); !errors.Is(err, apperr.ErrProgramNotFound) {
		t.Fatalf("missing delete: %v", err)
	}
	var exercises int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM exercises WHERE user_id=$1`, user).Scan(&exercises); err != nil || exercises != 0 {
		t.Fatalf("template changed catalog: %d %v", exercises, err)
	}
}

func TestProgramConcurrentPostgres(t *testing.T) {
	s, pool, ctx := localMobileStore(t)
	user := newTestUser(t, ctx, pool)
	req := programRequest("cc000000-0000-4000-8000-000000000004", "Concurrent")
	var wg sync.WaitGroup
	results := make(chan apiclient.Program, 2)
	errs := make(chan error, 2)
	created := make(chan bool, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			p, c, e := s.CreateProgram(ctx, user, req)
			results <- p
			errs <- e
			created <- c
		}()
	}
	wg.Wait()
	for i := 0; i < 2; i++ {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	a, b := <-results, <-results
	if !a.UpdatedAt.Equal(b.UpdatedAt) || (<-created) == (<-created) {
		t.Fatal("concurrent replay changed revision or created twice")
	}
	updateErrs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, e := s.UpdateProgram(ctx, user, a.ID, apiclient.UpdateProgramRequest{Name: "Updated", Entries: req.Entries, ExpectedUpdatedAt: a.UpdatedAt})
			updateErrs <- e
		}()
	}
	wg.Wait()
	e1, e2 := <-updateErrs, <-updateErrs
	if !((e1 == nil && errors.Is(e2, apperr.ErrConflict)) || (e2 == nil && errors.Is(e1, apperr.ErrConflict))) {
		t.Fatalf("revision race: %v %v", e1, e2)
	}
}
