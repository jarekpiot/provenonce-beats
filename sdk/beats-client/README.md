# @provenonce/beats-client

Minimal client for the public Beats service.

## Install (local for now)

```bash
npm i ./sdk/beats-client
```

## Usage

```js
import { createBeatsClient } from '@provenonce/beats-client';

const beats = createBeatsClient();

const anchor = await beats.getAnchor();
const receipt = await beats.timestampHash('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
```

## Endpoints wrapped

- `GET /api/health`
- `GET /api/v1/beat/anchor`
- `GET /api/v1/beat/key`
- `POST /api/v1/beat/verify`
- `POST /api/v1/beat/timestamp`

