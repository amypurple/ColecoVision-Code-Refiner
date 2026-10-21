FROM node:22-bookworm-slim

WORKDIR /app
COPY . .
RUN chmod +x third_party/cvbasic/cvbasic_linux third_party/cvbasic/gasm80_linux

ENV HOST=0.0.0.0
ENV PORT=8091
EXPOSE 8091

CMD ["npm", "start"]
