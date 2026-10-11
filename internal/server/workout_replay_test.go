package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"gymbro/internal/apiclient"
	"gymbro/internal/database"
	"gymbro/internal/store"
)

func TestOwnedWorkoutReplayHTTPPostgres(t *testing.T) {
	dsn := os.Getenv("GYMBRO_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set GYMBRO_TEST_DATABASE_URL to isolated localhost gymbro_mobile_test")
	}
	u, err := url.Parse(dsn)
	if err != nil || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") || u.Path != "/gymbro_mobile_test" {
		t.Fatal("only isolated localhost gymbro_mobile_test is allowed")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := database.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	st := store.New(pool)
	user, err := st.ResolveIdentity(ctx, "replay-test", fmt.Sprint(time.Now().UnixNano()))
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, e := pool.Exec(ctx, `DELETE FROM workouts WHERE user_id=$1`, user)
		if e != nil {
			t.Error(e)
		}
		_, e = pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, user)
		if e != nil {
			t.Error(e)
		}
	}()
	login, err := st.CreateLoginRequest(ctx, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	err = st.ConfirmLogin(ctx, login.Token, user)
	if err != nil {
		t.Fatal(err)
	}
	session, err := st.ClaimLogin(ctx, login.Nonce, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	v, err := newValidator()
	if err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(authenticate("dummy-service", st))
	h := handlers{store: st, validate: v}
	v1 := r.Group("/v1")
	h.register(v1.Group("", requireService()), v1.Group("", requireUserAccess()))
	path := fmt.Sprintf("/v1/users/%d/workouts", user)
	original := apiclient.SaveWorkoutRequest{PerformedOn: "2026-10-11", Type: "upper", RawText: "unchanged raw", Source: "mobile", SourceRef: "550e8400-e29b-41d4-a716-446655440000", Entries: []apiclient.Entry{{Name: "Written", Sets: []apiclient.Set{{Weight: "13.50", Reps: 8}}}}}
	encode := func(v any) string {
		b, e := json.Marshal(v)
		if e != nil {
			t.Fatal(e)
		}
		return string(b)
	}
	create := request(r, "POST", path, encode(original), "Bearer "+session.Token, "", "", "application/json")
	var first apiclient.SaveWorkoutResponse
	err = json.Unmarshal(create.Body.Bytes(), &first)
	if err != nil || create.Code != 201 {
		t.Fatalf("create: %d %s", create.Code, create.Body.String())
	}
	var entry int64
	err = pool.QueryRow(ctx, `SELECT id FROM workout_exercises WHERE workout_id=$1`, first.WorkoutID).Scan(&entry)
	if err != nil {
		t.Fatal(err)
	}
	// Both native and owning browser callers use non-mutating replay semantics.
	for _, browser := range []bool{false, true} {
		auth, cookie, csrf := "Bearer "+session.Token, "", ""
		if browser {
			auth = ""
			cookie = session.Token
			csrf = "1"
		}
		replay := request(r, "POST", path, encode(original), auth, cookie, csrf, "application/json")
		var got apiclient.SaveWorkoutResponse
		err = json.Unmarshal(replay.Body.Bytes(), &got)
		if err != nil || replay.Code != 200 || got.Created || got.WorkoutID != first.WorkoutID || !got.UpdatedAt.Equal(first.UpdatedAt) {
			t.Fatalf("replay: %d %s", replay.Code, replay.Body.String())
		}
	}
	var afterEntry int64
	err = pool.QueryRow(ctx, `SELECT id FROM workout_exercises WHERE workout_id=$1`, first.WorkoutID).Scan(&afterEntry)
	if err != nil || afterEntry != entry {
		t.Fatal("HTTP replay replaced entry")
	}
	differing := original
	differing.Entries = []apiclient.Entry{{Name: "Written", Sets: []apiclient.Set{{Weight: "14", Reps: 8}}}}
	conflict := request(r, "POST", path, encode(differing), "Bearer "+session.Token, "", "", "application/json")
	if conflict.Code != 409 || conflict.Body.String() != `{"error":"conflict"}` {
		t.Fatalf("structured replay: %d %s", conflict.Code, conflict.Body.String())
	}
	metadata := original
	intake := 0
	metadata.Kcal = &intake
	conflict = request(r, "POST", path, encode(metadata), "", session.Token, "1", "application/json")
	if conflict.Code != 409 || conflict.Body.String() != `{"error":"conflict"}` {
		t.Fatalf("browser metadata replay: %d %s", conflict.Code, conflict.Body.String())
	}
	// Lost POST response on A, then a revisioned PUT on B, then A's original replay.
	edit := apiclient.UpdateWorkoutRequest{PerformedOn: original.PerformedOn, Note: "device B newer", RawText: original.RawText, Entries: differing.Entries, ExpectedUpdatedAt: first.UpdatedAt}
	put := request(r, "PUT", fmt.Sprintf("%s/%d", path, first.WorkoutID), encode(edit), "Bearer "+session.Token, "", "", "application/json")
	if put.Code != 200 {
		t.Fatalf("PUT: %s", put.Body.String())
	}
	before, err := st.ListWorkouts(ctx, user, 10, "")
	if err != nil {
		t.Fatal(err)
	}
	conflict = request(r, "POST", path, encode(original), "Bearer "+session.Token, "", "", "application/json")
	if conflict.Code != 409 {
		t.Fatalf("lost response replay: %d %s", conflict.Code, conflict.Body.String())
	}
	after, err := st.ListWorkouts(ctx, user, 10, "")
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatalf("replay overwrote newer server content: %+v %v", after, err)
	}
	service := request(r, "POST", path, encode(original), "Bearer dummy-service", "", "", "application/json")
	if service.Code != 200 {
		t.Fatalf("service upsert: %d %s", service.Code, service.Body.String())
	}
	after, err = st.ListWorkouts(ctx, user, 10, "")
	if err != nil || after.Workouts[0].Note != nil || !after.Workouts[0].UpdatedAt.After(before.Workouts[0].UpdatedAt) {
		t.Fatalf("service upsert changed: %+v %v", after, err)
	}
}
