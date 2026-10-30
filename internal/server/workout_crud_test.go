package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"gymbro/internal/apiclient"
	"gymbro/internal/database"
	"gymbro/internal/store"
)

func TestOwnedWorkoutCRUDHTTPPostgres(t *testing.T) {
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
	user, err := st.ResolveIdentity(ctx, "crud-test", fmt.Sprint(time.Now().UnixNano()))
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
	// Native, browser, and service POST all create, even with identical provenance.
	ids := map[int64]bool{first.WorkoutID: true}
	for _, credential := range []string{"native", "browser", "service"} {
		auth, cookie, csrf := "Bearer "+session.Token, "", ""
		if credential == "browser" {
			auth, cookie, csrf = "", session.Token, "1"
		}
		if credential == "service" {
			auth = "Bearer dummy-service"
		}
		created := request(r, "POST", path, encode(original), auth, cookie, csrf, "application/json")
		var got apiclient.SaveWorkoutResponse
		err := json.Unmarshal(created.Body.Bytes(), &got)
		if err != nil || created.Code != 201 || !got.Created || ids[got.WorkoutID] {
			t.Fatalf("duplicate source POST: %d %s", created.Code, created.Body.String())
		}
		ids[got.WorkoutID] = true
	}
	target := fmt.Sprintf("%s/%d", path, first.WorkoutID)
	for i := 0; i < 2; i++ {
		edit := apiclient.UpdateWorkoutRequest{PerformedOn: original.PerformedOn, Note: fmt.Sprint(i), RawText: "new text"}
		put := request(r, "PUT", target, encode(edit), "Bearer "+session.Token, "", "", "application/json")
		if put.Code != 200 {
			t.Fatalf("revision-free PUT: %d %s", put.Code, put.Body.String())
		}
	}
	get := request(r, "GET", path, "", "Bearer "+session.Token, "", "", "")
	var page apiclient.ListWorkoutsResponse
	if err := json.Unmarshal(get.Body.Bytes(), &page); err != nil || get.Code != 200 || len(page.Workouts) != 4 {
		t.Fatalf("GET: %d %s", get.Code, get.Body.String())
	}
	for _, w := range page.Workouts {
		if w.ID == first.WorkoutID && (w.Name != "" || w.Type != nil || w.Note == nil || *w.Note != "1" || len(w.Entries) != 0 || w.SourceRef != original.SourceRef) {
			t.Fatalf("replacement: %+v", w)
		}
	}
	del := request(r, "DELETE", target, "", "Bearer "+session.Token, "", "", "")
	if del.Code != 204 {
		t.Fatalf("revision-free DELETE: %d %s", del.Code, del.Body.String())
	}
	del = request(r, "DELETE", target, "", "Bearer "+session.Token, "", "", "")
	if del.Code != 404 {
		t.Fatalf("deleted: %d %s", del.Code, del.Body.String())
	}
}
