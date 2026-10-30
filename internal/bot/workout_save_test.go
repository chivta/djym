package bot

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"gymbro/internal/apiclient"
	"gymbro/internal/bot/state"
)

func TestSaveWorkoutCreateThenEditAndRestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "bot.db")
	st, err := state.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	var methods []string
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		methods = append(methods, r.Method)
		if r.Header.Get("Authorization") != "Bearer test" {
			t.Error("missing service auth")
		}
		var body map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if _, ok := body["expected_updated_at"]; ok {
			t.Error("revision in workout request")
		}
		if r.Method == http.MethodPost {
			if r.URL.Path != "/v1/users/1/workouts" {
				t.Error(r.URL.Path)
			}
			w.WriteHeader(http.StatusCreated)
		} else {
			if r.Method != http.MethodPut || r.URL.Path != "/v1/users/1/workouts/42" {
				t.Error(r.Method, r.URL.Path)
			}
			if _, ok := body["source"]; ok {
				t.Error("PUT changed provenance")
			}
			if string(body["raw_text"]) != `"edited"` {
				t.Error("edit not sent")
			}
		}
		_ = json.NewEncoder(w).Encode(apiclient.SaveWorkoutResponse{WorkoutID: 42, Created: r.Method == http.MethodPost})
	}))
	defer api.Close()
	b := &Bot{state: st, api: apiclient.New(api.URL, "test", api.Client())}
	req := apiclient.SaveWorkoutRequest{PerformedOn: "2026-10-01", RawText: "original", Source: sourceTelegramBot, SourceRef: "1:2:3"}
	first := time.Unix(1700000000, 0)
	d := &draft{}
	if _, err := b.saveWorkout(ctx, 1, 2, 3, d, req, first, false); err != nil {
		t.Fatal(err)
	}
	if d.WorkoutID != 42 {
		t.Fatal("create target not retained")
	}
	// onEdited clears the saved marker but not the target.
	d.SavedWorkoutID = 0
	req.RawText = "edited"
	for i := 0; i < 2; i++ {
		if _, err := b.saveWorkout(ctx, 1, 2, 3, d, req, first, true); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	st, err = state.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	b.state = st
	// No live draft, as after expiry/restart: the durable mapping still selects PUT.
	if _, err := b.saveWorkout(ctx, 1, 2, 3, &draft{}, req, first, true); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(methods, []string{"POST", "PUT", "PUT", "PUT"}) {
		t.Fatal(methods)
	}
}

func TestSaveWorkoutHistoricalRecovery(t *testing.T) {
	for _, tc := range []struct {
		name      string
		matches   int
		truncated bool
		wantPut   bool
	}{
		{name: "unique", matches: 1, wantPut: true},
		{name: "missing"},
		{name: "ambiguous", matches: 2},
		{name: "bounded incomplete", matches: 1, truncated: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			st := openTestStore(t, filepath.Join(t.TempDir(), "bot.db"))
			first := time.Unix(1700000000, 0)
			if err := st.SetFirstSave(ctx, 2, 3, first); err != nil {
				t.Fatal(err)
			}
			gets, puts := 0, 0
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.Method {
				case http.MethodGet:
					gets++
					if r.URL.Query().Get("limit") != "100" {
						t.Error("unbounded request")
					}
					page := apiclient.ListWorkoutsResponse{Workouts: []apiclient.Workout{{ID: 99, Source: "other", SourceRef: "ref"}}}
					for i := 0; i < tc.matches; i++ {
						page.Workouts = append(page.Workouts, apiclient.Workout{ID: int64(42 + i), Source: sourceTelegramBot, SourceRef: "ref"})
					}
					if tc.truncated {
						// Only the first page matches; a partial scan must not select its ID.
						if gets > 1 {
							page.Workouts = nil
						}
						cursor := "next"
						page.NextCursor = &cursor
					}
					_ = json.NewEncoder(w).Encode(page)
				case http.MethodPut:
					puts++
					if r.URL.Path != "/v1/users/1/workouts/42" {
						t.Error(r.URL.Path)
					}
					_ = json.NewEncoder(w).Encode(apiclient.SaveWorkoutResponse{WorkoutID: 42})
				default:
					t.Error("recovery must never POST", r.Method)
					w.WriteHeader(500)
				}
			}))
			defer api.Close()
			b := &Bot{state: st, api: apiclient.New(api.URL, "test", api.Client())}
			req := apiclient.SaveWorkoutRequest{Source: sourceTelegramBot, SourceRef: "ref"}
			_, err := b.saveWorkout(ctx, 1, 2, 3, &draft{}, req, first, true)
			if tc.wantPut {
				if err != nil || puts != 1 {
					t.Fatalf("unique: puts=%d %v", puts, err)
				}
				if id, err := st.WorkoutID(ctx, 2, 3); err != nil || id != 42 {
					t.Fatalf("mapping: %d %v", id, err)
				}
			} else if !errors.Is(err, errWorkoutRecovery) || puts != 0 {
				t.Fatalf("unsafe recovery: puts=%d %v", puts, err)
			}
			if tc.truncated && gets != 10 {
				t.Fatalf("recovery bound: %d", gets)
			}
		})
	}
}

func TestSaveWorkoutDeletedTargetNeverCreates(t *testing.T) {
	ctx := context.Background()
	st := openTestStore(t, filepath.Join(t.TempDir(), "bot.db"))
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Error("deleted target recreated", r.Method)
		}
		w.WriteHeader(404)
		_, _ = w.Write([]byte(`{"error":"workout_not_found"}`))
	}))
	defer api.Close()
	b := &Bot{state: st, api: apiclient.New(api.URL, "test", api.Client())}
	// Legacy persisted drafts already contain SavedWorkoutID but not WorkoutID.
	d := &draft{SavedWorkoutID: 42}
	for i := 0; i < 2; i++ {
		_, err := b.saveWorkout(ctx, 1, 2, 3, d, apiclient.SaveWorkoutRequest{}, time.Now(), true)
		var apiErr *apiclient.Error
		if !errors.As(err, &apiErr) || apiErr.Code != apiclient.CodeWorkoutNotFound || d.WorkoutID != 42 {
			t.Fatalf("deleted target: %+v %v", d, err)
		}
		d.SavedWorkoutID = 0
	}
}
