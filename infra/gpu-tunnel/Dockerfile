# syntax=docker/dockerfile:1

# Stand end of the reverse tunnel from the model machine (docs/models.md, «Модели вне стенда: обратный туннель»): sshd
# without root, one account, no sessions, only reverse TCP forwarding to the two model ports. Its client arrives through
# busybox `nc 127.0.0.1 2222`, run in the container by `docker exec` from the server's sshd.
ARG ALPINE_IMAGE=alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

FROM ${ALPINE_IMAGE}
# The account's uid is also the owner of the key directory on the server (scripts/deploy/init-env.sh) and of the
# tmpfs in docker-compose.prod.yml. Alpine creates the account with the password "!", and sshd refuses a locked
# account even with a key: "*" leaves it without a password but not locked.
RUN apk add --no-cache openssh-server \
	&& adduser -D -H -h /nonexistent -u 10022 -s /sbin/nologin tunnel \
	&& sed -i 's/^tunnel:!:/tunnel:*:/' /etc/shadow \
	&& grep -q '^tunnel:\*:' /etc/shadow
COPY sshd_config /etc/ssh/sshd_config
COPY --chmod=0755 entrypoint.sh /entrypoint.sh
USER 10022:10022
EXPOSE 2222
ENTRYPOINT ["/entrypoint.sh"]
