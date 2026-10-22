# Live link

[← README](../README.md)

Another program edits a layer and the viewer's stage follows, in place, without reloading the page. The viewer's own edits travel the other way, so that program can read them. A browser cannot listen for connections, so a small relay sits in between: the program `PUT`s the layer to the relay, the viewer gets a server-sent event and fetches it. The relay is `web/live-relay.ts`: plain Node, no dependencies, everything in memory.

Pushed layers replace the matching open layer in memory. USD diffs the new content against the old, so only prims that changed are re-composed and redrawn. A push for a layer the stage does not have creates an in-memory **overlay** on top of the stage (see below).

## Running the relay

- `npm run dev` already serves it at `http://localhost:5173/live/`. Open the viewer with `live=1`: `http://localhost:5173/?src=samples/showcase.usda&live=1`.
- Any other host: `npm run live` (in `web/`) starts it alone on port 8765 (`node live-relay.ts 9000` for another port). Point the viewer at it with `?live=http://localhost:8765/live/`, or on an embedded element with `<usd-viewer live="http://localhost:8765/live/">`. From code: `viewer.live.connect(url)`, `viewer.live.disconnect()`, `viewer.live.connected`.

The viewer logs `Live link: connected to …` in its message area and fires a `livechange` event for every applied push.

**Layer names.** Programs name layers by file name or trailing path, not by the viewer's internal identifier: `showcase.usda` matches `http://localhost:5173/samples/showcase.usda`, `scene/geo.usda` matches `/drop/1/scene/geo.usda`. An ambiguous name (two `geo.usda` in different folders) is refused with a message; send more of the path. The viewer publishes its own layers under their file name, so push under the file name when you want to read them back under the same name.

## Protocol

| Request | Response |
|---|---|
| `PUT /live/layers/<name>`, body = the layer; `Content-Type: text/usda` (default) or `application/usdc`; optional `X-Live-Origin: <your id>` | `204`; every connected client gets a `layer` event |
| `GET /live/layers/<name>` | the latest bytes, their `Content-Type`, `X-Live-Version`; `404` if never pushed |
| `GET /live/layers` | JSON `[{ name, version, origin, type, size }]` |
| `DELETE /live/layers/<name>`, `DELETE /live/layers` | forgets what was pushed (the relay otherwise keeps the last push per name until it is restarted) |
| `GET /live/events` | `text/event-stream`: first one `layer` event per stored layer with `"replay": true`, then one per push: `event: layer` / `data: {"name","version","origin","type"}` |

All responses carry `Access-Control-Allow-Origin: *`, so a page can use a relay on another port. The relay has no authentication; run it on localhost or behind something that has.

## Examples

Edits have to land in a layer the viewer has open, or in an overlay. `pip install usd-core` gives Python the `pxr` modules. The samples below use `web/public/samples/showcase.usda`, opened in the viewer with `?src=samples/showcase.usda&live=1`.

### Python: push edits

```python
import time, urllib.request
from pxr import Gf, Usd, UsdGeom

RELAY = 'http://localhost:5173/live/'   # npm run live: http://localhost:8765/live/
stage = Usd.Stage.Open('web/public/samples/showcase.usda')
layer = stage.GetRootLayer()            # what the viewer has open
sphere = UsdGeom.XformCommonAPI(stage.GetPrimAtPath('/World/Shapes/Sphere'))

def push():
    request = urllib.request.Request(RELAY + 'layers/showcase.usda', method='PUT', data=layer.ExportToString().encode(),
                                     headers={'Content-Type': 'text/usda', 'X-Live-Origin': 'python'})
    urllib.request.urlopen(request)

for i in range(48):
    sphere.SetTranslate(Gf.Vec3d(-3, 0.6 + i / 24, 0))
    push()
    time.sleep(1 / 12)
```

The sphere rises in the viewer. Nothing touched the file: `layer.Save()` would, and then the viewer's own disk watcher would also notice (see [Without code](#without-code)).

### Python: receive the viewer's edits

Every edit in the viewer (gizmo, property panel, undo) publishes the edit-target layer under its file name, marked with the viewer's origin id. Follow the event stream, skip your own pushes, fetch and import:

```python
import json, urllib.request
from pxr import Sdf

RELAY = 'http://localhost:5173/live/'
layer = Sdf.Layer.FindOrOpen('web/public/samples/showcase.usda')   # the same layer object the push loop edits
with urllib.request.urlopen(RELAY + 'events') as events:
    for line in events:                                               # one SSE line at a time
        if not line.startswith(b'data:'):
            continue
        info = json.loads(line[5:])
        if info['name'] != 'showcase.usda' or info['origin'] == 'python':
            continue
        text = urllib.request.urlopen(RELAY + 'layers/' + info['name']).read().decode()
        layer.ImportFromString(text)   # diffs against the current content, like the viewer does
        print(info['version'], layer.GetAttributeAtPath('/World/Shapes/Sphere.xformOp:translate').default)
```

Run the push loop and this loop in two threads for a full two-way session. Last writer wins: a push overwrites viewer edits to that layer made since the previous one, and the other way round.

### Python: an overlay that leaves the file alone

Push under a name the stage does not have. The viewer creates an in-memory layer with that name above the stage; later pushes update it in place.

```python
import urllib.request
from pxr import Sdf, Usd, UsdGeom

RELAY = 'http://localhost:5173/live/'
overlay = Sdf.Layer.CreateAnonymous('overrides.usda')
scratch = Usd.Stage.Open(overlay)
cone = UsdGeom.Cone(scratch.OverridePrim('/World/Shapes/Cone'))   # an `over`: composes onto the file's prim
cone.CreateRadiusAttr(2.0)
cone.CreateDisplayColorAttr([(1.0, 0.2, 0.2)])
urllib.request.urlopen(urllib.request.Request(RELAY + 'layers/overrides.usda', method='PUT', data=overlay.ExportToString().encode()))
```

The overlay shows in the viewer's layer list, can be chosen as the edit target, and is never saved; File ▸ Download gives its usda when needed.

### C++: push edits (OpenUSD and libcurl)

```cpp
#include <pxr/usd/usd/stage.h>
#include <pxr/usd/usdGeom/xformCommonAPI.h>
#include <curl/curl.h>
#include <chrono>
#include <thread>
PXR_NAMESPACE_USING_DIRECTIVE

int main()
{
    UsdStageRefPtr stage = UsdStage::Open("web/public/samples/showcase.usda");
    UsdGeomXformCommonAPI sphere(stage->GetPrimAtPath(SdfPath("/World/Shapes/Sphere")));
    CURL* curl = curl_easy_init();
    curl_slist* headers = curl_slist_append(nullptr, "Content-Type: text/usda");
    headers = curl_slist_append(headers, "X-Live-Origin: cpp");
    curl_easy_setopt(curl, CURLOPT_URL, "http://localhost:5173/live/layers/showcase.usda");
    curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "PUT");
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    for (int i = 0; i < 48; ++i) {
        sphere.SetTranslate(GfVec3d(-3, 0.6 + i / 24.0, 0));
        std::string text;
        stage->GetRootLayer()->ExportToString(&text);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, text.c_str());
        curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, long(text.size()));
        curl_easy_perform(curl);
        std::this_thread::sleep_for(std::chrono::milliseconds(80));
    }
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
}
```

### C++: receive the viewer's edits

libcurl hands the event stream to a write callback; messages end at a blank line.

```cpp
#include <pxr/base/js/json.h>
#include <pxr/usd/sdf/layer.h>
#include <curl/curl.h>
PXR_NAMESPACE_USING_DIRECTIVE

static std::string Get(const std::string& url)
{
    std::string body;
    CURL* curl = curl_easy_init();
    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, +[](char* data, size_t, size_t n, void* out) { static_cast<std::string*>(out)->append(data, n); return n; });
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &body);
    curl_easy_perform(curl);
    curl_easy_cleanup(curl);
    return body;
}

int main()
{
    const std::string relay = "http://localhost:5173/live/";
    SdfLayerRefPtr layer = SdfLayer::FindOrOpen("web/public/samples/showcase.usda");
    struct State { std::string buffer; SdfLayerRefPtr layer; const std::string* relay; } state { "", layer, &relay };
    CURL* curl = curl_easy_init();
    curl_easy_setopt(curl, CURLOPT_URL, (relay + "events").c_str());
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &state);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, +[](char* data, size_t, size_t n, void* userdata) {
        State& s = *static_cast<State*>(userdata);
        s.buffer.append(data, n);
        for (size_t end; (end = s.buffer.find("\n\n")) != std::string::npos; s.buffer.erase(0, end + 2)) {
            const size_t at = s.buffer.find("data:");
            if (at == std::string::npos || at > end) continue;
            const JsObject info = JsParseString(s.buffer.substr(at + 5, end - at - 5)).GetJsObject();
            if (info.at("name").GetString() != "showcase.usda" || info.at("origin").GetString() == "cpp") continue;
            s.layer->ImportFromString(Get(*s.relay + "layers/showcase.usda"));
        }
        return n;
    });
    curl_easy_perform(curl); // runs until the relay goes away
}
```

### curl

```sh
curl -X PUT --data-binary @web/public/samples/showcase.usda http://localhost:5173/live/layers/showcase.usda
curl -N http://localhost:5173/live/events          # watch pushes, the viewer's included
curl -X DELETE http://localhost:5173/live/layers   # forget everything the relay holds
```

Add `-H 'Content-Type: application/usdc'` for a binary layer.

## Without code

A folder opened with File ▸ Folder… in Chromium is already watched: when another program saves a file in it, the viewer re-reads that layer within 2 s, unless the viewer has unsaved edits (see [Using the viewer](using.md#editing)). That path replaces the layer from disk and clears the undo history. The live link is for stages opened from URLs, for other browsers, for programs that should not write the file, and for reading the viewer's edits back.

## Limits

- Each push carries the whole layer. Fine up to tens of MB; the next step would be sending change lists.
- Layers in crate format (`.usdc`, binary `.usd`) cannot be diffed in place: a push to one re-composes the whole layer.
- Pushes are not undoable in the viewer; the undo history is cleared, like after a reload.
- A pushed file layer becomes unsaved in the viewer. Save writes what the viewer has; if your program also writes the file, the disk watcher warns.
- Overlays are never saved and get no change markers in the hierarchy. "Clear edits" on the session layer drops them until the next push.
- Refinement overrides (`refinementLevel`, `refinementEnableOverride`) pushed from outside take effect on the next refinement change or reload.
- Members of a usdz package can only be addressed by their full identifier and cannot be saved.
- The viewer publishes only the edit-target layer, after each edit or at the end of a drag. Viewer-side hiding (session layer) is not published.
