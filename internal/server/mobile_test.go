package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"gymbro/internal/apiclient"
	"gymbro/internal/apperr"
	"gymbro/internal/store"
)

type mobileStoreFake struct {
	handlerStore // Unused methods panic, so accidental boundary calls fail tests.
	claimedNonce string
	deletedToken string
	session      *store.Session
	save         apiclient.SaveWorkoutRequest
	update       apiclient.UpdateWorkoutRequest
	expected     time.Time
	calls        int
	mutationErr  error
}

func (f *mobileStoreFake) SessionUser(_ context.Context, tok string) (int64, error) {
	if tok == "native" || tok == "cookie" {
		return 1, nil
	}
	return 0, apperr.ErrUnauthorized
}
func (f *mobileStoreFake) CreateLoginRequest(context.Context, time.Duration) (store.LoginRequest, error) {
	return store.LoginRequest{Token: "bot-token", Nonce: strings.Repeat("n", 43), ExpiresAt: time.Now().Add(loginTTL)}, nil
}
func (f *mobileStoreFake) ClaimLogin(_ context.Context, nonce string, ttl time.Duration) (*store.Session, error) {
	f.claimedNonce = nonce
	if ttl != sessionTTL {
		panic("wrong session TTL")
	}
	return f.session, nil
}
func (f *mobileStoreFake) DeleteSession(_ context.Context, tok string) error {
	f.deletedToken = tok
	return nil
}
func (f *mobileStoreFake) SaveWorkout(_ context.Context, _ int64, req apiclient.SaveWorkoutRequest) (apiclient.SaveWorkoutResponse, error) {
	f.save = req
	f.calls++
	return apiclient.SaveWorkoutResponse{WorkoutID: 7, Created: true, UpdatedAt: revision, NewExercises: []string{}}, f.mutationErr
}
func (f *mobileStoreFake) UpdateWorkout(_ context.Context, userID, workoutID int64, req apiclient.UpdateWorkoutRequest) (apiclient.SaveWorkoutResponse, error) {
	if userID != 1 || workoutID != 7 {
		panic("wrong ownership arguments")
	}
	f.update = req
	f.calls++
	return apiclient.SaveWorkoutResponse{WorkoutID: 7, UpdatedAt: revision, NewExercises: []string{}}, f.mutationErr
}
func (f *mobileStoreFake) DeleteWorkout(_ context.Context, userID, workoutID int64, expected time.Time) error {
	if userID != 1 || workoutID != 7 {
		panic("wrong ownership arguments")
	}
	f.expected = expected
	f.calls++
	return f.mutationErr
}

var revision = time.Date(2026, 10, 3, 12, 0, 0, 123456000, time.UTC)

func mobileRouter(t *testing.T, f *mobileStoreFake) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	v, err := newValidator()
	if err != nil {
		t.Fatal(err)
	}
	h := &handlers{store: f, validate: v, botUsername: "gymbro_bot"}
	r := gin.New()
	r.Use(authenticate("bot-secret", f))
	v1 := r.Group("/v1")
	h.register(v1.Group("", requireService()), v1.Group("", requireUserAccess()))
	auth := r.Group("/auth")
	h.registerAuth(auth, auth.Group("", requireSession()))
	return r
}

func request(r http.Handler, method, path, body, auth, cookie, csrf, contentType string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: sessionCookie, Value: cookie})
	}
	if csrf != "" {
		req.Header.Set("X-Gymbro-Write", csrf)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestNativeAuthentication(t *testing.T) {
	tests := []struct {
		name, auth, cookie, path string
		status                   int
	}{
		{"native me", "Bearer native", "", "/auth/me", 200},
		{"cookie me", "", "cookie", "/auth/me", 200},
		{"unknown no cookie fallback", "Bearer unknown", "cookie", "/auth/me", 401},
		{"expired no cookie fallback", "Bearer expired", "cookie", "/auth/me", 401},
		{"malformed no fallback", "Basic native", "cookie", "/auth/me", 401},
		{"empty bearer", "Bearer ", "cookie", "/auth/me", 401},
		{"extra bearer words", "Bearer native other", "cookie", "/auth/me", 401},
		{"native no service permissions", "Bearer native", "", "/v1/users/1/exercises", 403},
		{"bot no user session", "Bearer bot-secret", "", "/auth/me", 401},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := request(mobileRouter(t, &mobileStoreFake{}), "GET", tt.path, "", tt.auth, tt.cookie, "", "")
			if w.Code != tt.status {
				t.Fatalf("status %d: %s", w.Code, w.Body.String())
			}
			if strings.Contains(w.Body.String(), "session_token") {
				t.Fatal("me leaked token")
			}
		})
	}
}

func TestMobileLoginAndWebCompatibility(t *testing.T) {
	f := &mobileStoreFake{}
	r := mobileRouter(t, f)
	w := request(r, "POST", "/auth/telegram/mobile/login", "", "", "", "", "")
	var start apiclient.StartMobileLoginResponse
	err := json.Unmarshal(w.Body.Bytes(), &start)
	if err != nil || w.Code != 200 || len(start.Nonce) != 43 || strings.Contains(start.BotURL, start.Nonce) || !strings.Contains(start.BotURL, "start=bot-token") || len(w.Result().Cookies()) != 0 {
		t.Fatalf("bad mobile login: %s", w.Body.String())
	}
	body := `{"nonce":"` + start.Nonce + `"}`
	w = request(r, "POST", "/auth/telegram/mobile/poll", body, "", "", "", "application/json")
	if w.Body.String() != `{"status":"pending"}` || f.claimedNonce != start.Nonce {
		t.Fatalf("bad pending: %s", w.Body.String())
	}
	f.session = &store.Session{Token: "native", UserID: 1, ExpiresAt: revision}
	w = request(r, "POST", "/auth/telegram/mobile/poll", body, "", "", "", "application/json")
	var poll apiclient.PollMobileLoginResponse
	err = json.Unmarshal(w.Body.Bytes(), &poll)
	if err != nil || poll.SessionToken != "native" || poll.UserID != 1 || poll.ExpiresAt == nil || len(w.Result().Cookies()) != 0 {
		t.Fatalf("bad confirmed: %s", w.Body.String())
	}
	for _, bad := range []string{`{}`, `{"nonce":"short"}`, `{"nonce":"` + strings.Repeat("n", 44) + `"}`} {
		w = request(r, "POST", "/auth/telegram/mobile/poll", bad, "", "", "", "application/json")
		if w.Code != 400 {
			t.Fatalf("accepted bad nonce %s", bad)
		}
	}
	w = request(r, "POST", "/auth/telegram/login", "", "", "", "", "")
	if w.Code != 200 || strings.Contains(w.Body.String(), "nonce") || len(w.Result().Cookies()) != 1 {
		t.Fatalf("web login changed: %s", w.Body.String())
	}
	req := httptest.NewRequest("POST", "/auth/telegram/poll", nil)
	req.AddCookie(&http.Cookie{Name: loginCookie, Value: start.Nonce})
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != 200 || strings.Contains(w.Body.String(), "session_token") || !strings.Contains(w.Body.String(), `"user_id":1`) {
		t.Fatalf("web poll changed: %s", w.Body.String())
	}
}

func TestLogoutRevokesActualSession(t *testing.T) {
	for _, native := range []bool{false, true} {
		f := &mobileStoreFake{}
		r := mobileRouter(t, f)
		auth, want := "", "cookie"
		if native {
			auth, want = "Bearer native", "native"
		}
		w := request(r, "POST", "/auth/logout", "", auth, "cookie", "", "")
		if w.Code != 204 || f.deletedToken != want {
			t.Fatalf("wrong revocation: %d %s", w.Code, f.deletedToken)
		}
		if (len(w.Result().Cookies()) != 0) == native {
			t.Fatal("wrong cookie clearing")
		}
	}
}

func TestOwnedWorkoutWrites(t *testing.T) {
	create := `{"performed_on":"2026-10-03","raw_text":"x","source":"mobile","source_ref":"550e8400-e29b-41d4-a716-446655440000","entries":[{"name":" squat ","sets":[]}]}`
	update := `{"performed_on":"2026-10-03","raw_text":"x","entries":[{"name":" squat ","sets":[]}],"expected_updated_at":"2026-10-03T12:00:00.123456Z"}`
	del := `{"expected_updated_at":"2026-10-03T12:00:00.123456Z"}`
	tests := []struct {
		name, method, path, body, auth, cookie, csrf, contentType string
		status                                                    int
		err                                                       error
	}{
		{"native create", "POST", "/v1/users/1/workouts", create, "Bearer native", "", "", "application/json", 201, nil},
		{"bot old source", "POST", "/v1/users/1/workouts", strings.ReplaceAll(create, `"mobile"`, `"telegram"`), "Bearer bot-secret", "", "", "application/json", 201, nil},
		{"native wrong source", "POST", "/v1/users/1/workouts", strings.ReplaceAll(create, `"mobile"`, `"telegram"`), "Bearer native", "", "", "application/json", 400, nil},
		{"native invalid UUID", "POST", "/v1/users/1/workouts", strings.ReplaceAll(create, "550e8400-e29b-41d4-a716-446655440000", "1"), "Bearer native", "", "", "application/json", 400, nil},
		{"wrong user", "POST", "/v1/users/2/workouts", create, "Bearer native", "", "", "application/json", 403, nil},
		{"cookie missing header", "POST", "/v1/users/1/workouts", create, "", "cookie", "", "application/json", 403, nil},
		{"cookie form", "POST", "/v1/users/1/workouts", create, "", "cookie", "1", "text/plain", 403, nil},
		{"cookie valid", "POST", "/v1/users/1/workouts", create, "", "cookie", "1", "application/json; charset=utf-8", 201, nil},
		{"native update historical empty sets", "PUT", "/v1/users/1/workouts/7", update, "Bearer native", "", "", "application/json", 200, nil},
		{"update cannot change source", "PUT", "/v1/users/1/workouts/7", strings.Replace(update, `"raw_text":"x"`, `"raw_text":"x","source":"mobile"`, 1), "Bearer native", "", "", "application/json", 400, nil},
		{"update missing revision", "PUT", "/v1/users/1/workouts/7", `{"performed_on":"2026-10-03","raw_text":"x"}`, "Bearer native", "", "", "application/json", 400, nil},
		{"update conflict", "PUT", "/v1/users/1/workouts/7", update, "Bearer native", "", "", "application/json", 409, apperr.ErrConflict},
		{"update missing", "PUT", "/v1/users/1/workouts/7", update, "Bearer native", "", "", "application/json", 404, apperr.ErrWorkoutNotFound},
		{"delete", "DELETE", "/v1/users/1/workouts/7", del, "Bearer native", "", "", "application/json", 204, nil},
		{"delete conflict", "DELETE", "/v1/users/1/workouts/7", del, "Bearer native", "", "", "application/json", 409, apperr.ErrConflict},
		{"delete missing revision", "DELETE", "/v1/users/1/workouts/7", `{}`, "Bearer native", "", "", "application/json", 400, nil},
		{"delete wrong user", "DELETE", "/v1/users/2/workouts/7", del, "Bearer native", "", "", "application/json", 403, nil},
		{"cookie delete missing header", "DELETE", "/v1/users/1/workouts/7", del, "", "cookie", "", "application/json", 403, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := &mobileStoreFake{mutationErr: tt.err}
			w := request(mobileRouter(t, f), tt.method, tt.path, tt.body, tt.auth, tt.cookie, tt.csrf, tt.contentType)
			if w.Code != tt.status {
				t.Fatalf("status %d want %d: %s", w.Code, tt.status, w.Body.String())
			}
			if tt.status == 400 || tt.status == 403 {
				if f.calls != 0 {
					t.Fatal("invalid request reached store")
				}
			}
			if tt.status == 201 && f.save.Entries[0].Name != "squat" {
				t.Fatal("name not trimmed")
			}
			if tt.status == 200 && (!f.update.ExpectedUpdatedAt.Equal(revision) || f.update.Entries[0].Name != "squat") {
				t.Fatal("update lost revision/name")
			}
			if tt.status == 204 && !f.expected.Equal(revision) {
				t.Fatal("delete lost precision")
			}
			if tt.status == 404 && !strings.Contains(w.Body.String(), "workout_not_found") {
				t.Fatal("wrong not-found code")
			}
		})
	}
}

func TestMalformedAuthorizationNeverUsesCookie(t *testing.T) {
	for _, headers := range [][]string{{""}, {"Bearer native", "Bearer bot-secret"}} {
		r := mobileRouter(t, &mobileStoreFake{})
		req := httptest.NewRequest("GET", "/auth/me", nil)
		req.Header["Authorization"] = headers
		req.AddCookie(&http.Cookie{Name: sessionCookie, Value: "cookie"})
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("accepted malformed authorization: %d", w.Code)
		}
	}
}
