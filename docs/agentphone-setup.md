# AgentPhone setup

Everything below was done through the REST API (`https://api.agentphone.ai/v1`). No dashboard
changes were needed.

## Agent

`Personal Call Agent`, id `cmv4g0h0t2en1lfp4z9cdvep2`, created 2026-10-11.

| Field | Value | Why |
|---|---|---|
| `voiceMode` | `hosted` | AgentPhone runs the conversation. Every call sends its own `systemPrompt`. |
| `enableMessaging` | `false` | The voice agent must never text the person it's calling. Result texts go through `POST /v1/messages` from our code. |
| `voice` | `cartesia-Cleo` | American English, natural. Can be overridden per call. |
| `voicemailMessage` | `null` | Don't leave a voicemail on the user's behalf by default. |
| `sttMode` | `accurate` | Names, times, and confirmation numbers matter more than a few ms of latency. |
| `maxSilenceMs` | `30000` | Ends dead calls instead of holding the line for 10 minutes (account default). |

## Number

`+16282224629` (id `cms3t1c9d02hsebnlog5uec0x`): the only number on the account with `outboundSms: enabled`.

It was moved from the Opendoor demo:

```bash
POST  /v1/agents/cmv4g0h0t2en1lfp4z9cdvep2/numbers   {"numberId": "cms3t1c9d02hsebnlog5uec0x"}
PATCH /v1/numbers/cms3t1c9d02hsebnlog5uec0x/voice-routing   {"method": "agent"}
```

### Revert (give the number back to Opendoor)

```bash
POST  /v1/agents/cmuwzdu5f2z7bc568nih3oijv/numbers   {"numberId": "cms3t1c9d02hsebnlog5uec0x"}
PATCH /v1/numbers/cms3t1c9d02hsebnlog5uec0x/voice-routing \
      {"method": "sip_trunk", "sipTrunkId": "cmuwzms4o00lhcv5awvu5gfmo"}
```

The other number, `+17276090163`, still belongs to the starter demo agent and needs SMS registration
before it can send texts.
