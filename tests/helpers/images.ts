// Container images for tests. Keep in sync with compose.yaml.
export const POSTGRES_IMAGE = 'pgvector/pgvector:0.8.6-pg17-trixie';
export const REDIS_IMAGE = 'valkey/valkey:9.1.2-alpine';
export const STORAGE_IMAGE = 'chrislusf/seaweedfs:4.47';
export const EMBEDDER_IMAGE = 'ghcr.io/ggml-org/llama.cpp:server-b11176';
// FSP ID is a Keycloak realm; the image the OIDC client is checked against (not part of compose.yaml).
export const KEYCLOAK_IMAGE = 'quay.io/keycloak/keycloak:26.8.0';
