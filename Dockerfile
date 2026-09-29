# ghcr.io/uk-sw/nxip-agent: the nxip CLI as a container, for the `agent`
# subcommand that reads Cisco routing tables on a schedule and files change
# proposals (docs/specs/nxip-agent-cisco.md in net-saas-monorepo).
#
# Built from the published npm package, not from this checkout, so the
# image is exactly what `npx nxip-cli@<version>` runs. release.yml builds it
# after the npm publish job on the same tag and passes the version in.
#
# One stage, Node slim, no build tools: everything nxip-cli depends on is
# pure JavaScript except ssh2's optional cpu-features binding, which is
# skipped without a compiler and changes nothing but a cipher benchmark.
FROM node:24-slim

# GHCR links a package to its repository through this label and nothing
# else. Without it the package is its own unlinked, private thing: the
# README's `docker run ghcr.io/uk-sw/nxip-agent` fails for everybody but the
# account that pushed it, with an error about authentication rather than
# about visibility.
LABEL org.opencontainers.image.source=https://github.com/uk-sw/nxip-cli

ARG NXIP_VERSION=latest

# --ignore-scripts refuses every install script, including the optional
# native build, so the install has no compiler to want. Then the cache is
# dropped so the layer holds the package and nothing else.
RUN npm install -g --ignore-scripts "nxip-cli@${NXIP_VERSION}" \
  && npm cache clean --force

# Where the config, known_hosts and any key file are mounted, as the docs
# show them: /agent/agent.yaml, /agent/known_hosts, /agent/id_ed25519.
RUN mkdir -p /agent /out && chown -R node:node /agent /out
WORKDIR /agent
USER node

ENTRYPOINT ["nxip"]
CMD ["--help"]
