# ── Stage: Nginx serving static files ──
FROM nginx:alpine-slim

# Domain of the be service, e.g. https://api.example.com
# Change this and rebuild whenever the backend domain changes.
ARG API_HOST=

COPY public/ /usr/share/nginx/html/
RUN sed -i "s|\${API_HOST}|${API_HOST}|" /usr/share/nginx/html/index.html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
