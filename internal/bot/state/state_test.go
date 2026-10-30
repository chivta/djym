package state

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestFirstSave(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "bot.db")
	s, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}

	_, ok, err := s.FirstSave(ctx, 1, 2)
	if err != nil || ok {
		t.Fatalf("missing: ok=%v err=%v", ok, err)
	}

	first := time.Unix(1_700_000_000, 0)
	if err := s.SetFirstSave(ctx, 1, 2, first); err != nil {
		t.Fatal(err)
	}
	// A second set must not overwrite.
	if err := s.SetFirstSave(ctx, 1, 2, first.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}

	// Reopen: the value survives a restart.
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	got, ok, err := s.FirstSave(ctx, 1, 2)
	if err != nil || !ok || !got.Equal(first) {
		t.Fatalf("got=%v ok=%v err=%v", got, ok, err)
	}
	_, ok, _ = s.FirstSave(ctx, 1, 3)
	if ok {
		t.Fatal("other message must be missing")
	}
}

func TestWorkoutMappingOutlivesDraftsAndRestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "bot.db")
	s, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	first := time.Unix(1700000000, 0)
	if id, err := s.WorkoutID(ctx, 1, 2); err != nil || id != 0 {
		t.Fatalf("missing: %d %v", id, err)
	}
	if err := s.SetWorkoutSave(ctx, 1, 2, 42, first); err != nil {
		t.Fatal(err)
	}
	if err := s.SetWorkoutSave(ctx, 1, 2, 42, first.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveDraft(ctx, 1, 2, Draft{Data: "{}", Touched: first}); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteDraftsBefore(ctx, first.Add(49*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if id, err := s.WorkoutID(ctx, 1, 2); err != nil || id != 42 {
		t.Fatalf("reopened: %d %v", id, err)
	}
	if got, ok, err := s.FirstSave(ctx, 1, 2); err != nil || !ok || !got.Equal(first) {
		t.Fatalf("first save changed: %v %v %v", got, ok, err)
	}
	if id, err := s.WorkoutID(ctx, 1, 3); err != nil || id != 0 {
		t.Fatalf("other message: %d %v", id, err)
	}
	if _, ok, err := s.LoadDraft(ctx, 1, 2); err != nil || ok {
		t.Fatalf("expired draft: %v %v", ok, err)
	}
}
