package apiclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// Error is returned for any non-2xx API response. Branch on Code, e.g. CodeBadNameIsAlias.
type Error struct {
	Status int
	Code   string
}

func (e *Error) Error() string {
	return fmt.Sprintf("api error: status %d, code %q", e.Status, e.Code)
}

// Client is a thin JSON client for the gymbro API. No retries.
type Client struct {
	baseURL    string
	secret     string
	httpClient *http.Client
}

func New(baseURL, secret string, httpClient *http.Client) *Client {
	return &Client{baseURL: strings.TrimRight(baseURL, "/"), secret: secret, httpClient: httpClient}
}

func (c *Client) ResolveIdentity(ctx context.Context, req ResolveIdentityRequest) (ResolveIdentityResponse, error) {
	var resp ResolveIdentityResponse
	err := c.do(ctx, http.MethodPost, "/v1/identities/resolve", req, &resp)
	return resp, err
}

func (c *Client) CreateWorkout(ctx context.Context, userID int64, req SaveWorkoutRequest) (SaveWorkoutResponse, error) {
	var resp SaveWorkoutResponse
	err := c.do(ctx, http.MethodPost, fmt.Sprintf("/v1/users/%d/workouts", userID), req, &resp)
	return resp, err
}

// UpdateWorkout fully replaces content by ID, without a revision precondition.
func (c *Client) UpdateWorkout(ctx context.Context, userID, workoutID int64, req UpdateWorkoutRequest) (SaveWorkoutResponse, error) {
	var resp SaveWorkoutResponse
	err := c.do(ctx, http.MethodPut, fmt.Sprintf("/v1/users/%d/workouts/%d", userID, workoutID), req, &resp)
	return resp, err
}

func (c *Client) DeleteWorkout(ctx context.Context, userID, workoutID int64) error {
	return c.do(ctx, http.MethodDelete, fmt.Sprintf("/v1/users/%d/workouts/%d", userID, workoutID), nil, nil)
}

// ListWorkouts returns one page of the user's workouts, newest first. Pass the
// previous response's NextCursor as before, or "" for the first page.
func (c *Client) ListWorkouts(ctx context.Context, userID int64, limit int, before string) (ListWorkoutsResponse, error) {
	query := url.Values{"limit": {strconv.Itoa(limit)}}
	if before != "" {
		query.Set("before", before)
	}
	var resp ListWorkoutsResponse
	err := c.do(ctx, http.MethodGet, fmt.Sprintf("/v1/users/%d/workouts?%s", userID, query.Encode()), nil, &resp)
	return resp, err
}

func (c *Client) ListExercises(ctx context.Context, userID int64) (ListExercisesResponse, error) {
	var resp ListExercisesResponse
	err := c.do(ctx, http.MethodGet, fmt.Sprintf("/v1/users/%d/exercises", userID), nil, &resp)
	return resp, err
}

func (c *Client) ReplaceExercise(ctx context.Context, userID int64, req ReplaceExerciseRequest) (ReplaceExerciseResponse, error) {
	var resp ReplaceExerciseResponse
	err := c.do(ctx, http.MethodPost, fmt.Sprintf("/v1/users/%d/exercises/replace", userID), req, &resp)
	return resp, err
}

// ConfirmLogin confirms a web sign-in request on behalf of a Telegram user.
// Fails with CodeLoginInvalid or CodeLoginExpired when the token cannot be used.
func (c *Client) ConfirmLogin(ctx context.Context, req ConfirmLoginRequest) error {
	return c.do(ctx, http.MethodPost, "/v1/auth/telegram/confirm", req, nil)
}

// do sends the request and decodes the JSON response into respBody; a nil
// respBody skips decoding (for 204 responses).
func (c *Client) do(ctx context.Context, method, path string, reqBody, respBody any) error {
	var body io.Reader
	if reqBody != nil {
		raw, err := json.Marshal(reqBody)
		if err != nil {
			return fmt.Errorf("encode request: %w", err)
		}
		body = bytes.NewReader(raw)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.secret)
	if reqBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		var payload struct {
			Error string `json:"error"`
		}
		// A body that is not the API's error JSON leaves Code empty.
		_ = json.NewDecoder(resp.Body).Decode(&payload)
		return &Error{Status: resp.StatusCode, Code: payload.Error}
	}

	if respBody == nil {
		return nil
	}
	err = json.NewDecoder(resp.Body).Decode(respBody)
	if err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}
