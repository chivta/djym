package apiclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestWorkoutCRUDRequests(t *testing.T) {
	var methods []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		methods = append(methods, r.Method)
		if r.Header.Get("Authorization") != "Bearer test" {
			t.Error("missing auth")
		}
		path := "/v1/users/12/workouts"
		if r.Method == http.MethodPut || r.Method == http.MethodDelete {
			path += "/34"
		}
		if r.URL.Path != path {
			t.Error(r.URL.Path)
		}
		if r.Method == http.MethodDelete {
			if r.ContentLength != 0 {
				t.Error("DELETE has a body")
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method == http.MethodGet {
			_, _ = w.Write([]byte(`{"workouts":[],"next_cursor":null}`))
			return
		}
		var body map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if _, ok := body["expected_updated_at"]; ok {
			t.Error("revision token sent")
		}
		_, _ = w.Write([]byte(`{"workout_id":34,"created":true,"new_exercises":[]}`))
	}))
	defer srv.Close()
	c := New(srv.URL, "test", srv.Client())
	ctx := context.Background()
	if _, err := c.CreateWorkout(ctx, 12, SaveWorkoutRequest{PerformedOn: "2026-10-01", RawText: "raw", Source: "test", SourceRef: "ref"}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.ListWorkouts(ctx, 12, 20, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := c.UpdateWorkout(ctx, 12, 34, UpdateWorkoutRequest{PerformedOn: "2026-10-02", RawText: "edited"}); err != nil {
		t.Fatal(err)
	}
	if err := c.DeleteWorkout(ctx, 12, 34); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(methods, []string{"POST", "GET", "PUT", "DELETE"}) {
		t.Fatal(methods)
	}
}
