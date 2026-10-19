package app.vitra.cosmetics;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientPacketListener;
import net.minecraft.client.multiplayer.PlayerInfo;
import net.minecraft.client.multiplayer.ServerData;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

public final class Directory {
    public record Cape(String id, String url, int width, int height, int frames, int delay) {}

    private record Entry(boolean vitra, boolean online, String badge, Cape cape, long fetched) {}

    private static final long REFRESH_MS = TimeUnit.MINUTES.toMillis(3);
    private static final long PING_MS = TimeUnit.SECONDS.toMillis(60);
    private static final int BATCH = 250;

    private static final Map<UUID, Entry> players = new ConcurrentHashMap<>();
    private static final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(8)).build();
    private static volatile boolean tokenWorks = !VitraCosmetics.TOKEN.isEmpty();
    private static long lastPing;
    private static String lastPlace = "";

    private Directory() {}

    public static void start() {
        Thread t = new Thread(Directory::run, "Vitra cosmetics");
        t.setDaemon(true);
        t.start();
    }

    public static String badge(UUID id) {
        Entry e = players.get(id);
        if (e != null && e.online) return e.badge;
        return id.equals(self()) && tokenWorks ? (e != null && e.badge != null ? e.badge : "vitra") : null;
    }

    public static Cape cape(UUID id) {
        Entry e = players.get(id);
        return e == null ? null : e.cape;
    }

    private static UUID self() {
        return Minecraft.getInstance().getUser().getProfileId();
    }

    private static void run() {
        while (true) {
            try {
                tick();
            } catch (Exception e) {
                VitraCosmetics.LOG.debug("lookup failed", e);
            }
            try {
                Thread.sleep(2000);
            } catch (InterruptedException e) {
                return;
            }
        }
    }

    private static void tick() throws Exception {
        String place = Minecraft.getInstance().submit(Directory::place).get(5, TimeUnit.SECONDS);
        if (!place.equals(lastPlace)) {
            lastPlace = place;
            VitraCosmetics.LOG.info("Vitra presence: {}", place);
        }
        List<UUID> around = Minecraft.getInstance().submit(Directory::playersAround).get(5, TimeUnit.SECONDS);
        long now = System.currentTimeMillis();
        if (tokenWorks && now - lastPing > PING_MS) {
            lastPing = now;
            List<UUID> ask = around.size() > BATCH ? around.subList(0, BATCH) : around;
            JsonObject res = post("/v1/ping", ask, true);
            if (res == null) {
                tokenWorks = false;
            } else {
                store(ask, res, now);
                players.compute(self(), (k, e) -> new Entry(true, true, e == null ? "vitra" : e.badge, e == null ? null : e.cape, now));
            }
            return;
        }
        List<UUID> unknown = new ArrayList<>();
        for (UUID id : around) {
            Entry e = players.get(id);
            if (e == null || now - e.fetched > REFRESH_MS) unknown.add(id);
            if (unknown.size() == BATCH) break;
        }
        if (unknown.isEmpty()) return;
        JsonObject res = post("/v1/lookup", unknown, tokenWorks);
        if (res != null) store(unknown, res, now);
    }

    private static String place() {
        Minecraft mc = Minecraft.getInstance();
        if (mc.getConnection() == null) return "menu";
        if (mc.getSingleplayerServer() != null) return "world";
        ServerData server = mc.getCurrentServer();
        if (server == null) return "world";
        return server.isRealm() ? "realms" : "server " + server.ip;
    }

    private static List<UUID> playersAround() {
        List<UUID> ids = new ArrayList<>();
        ids.add(self());
        ClientPacketListener connection = Minecraft.getInstance().getConnection();
        if (connection != null) {
            for (PlayerInfo info : connection.getOnlinePlayers()) {
                UUID id = info.getProfile().id();
                if (id.version() == 4 && !ids.contains(id)) ids.add(id);
            }
        }
        return ids;
    }

    private static JsonObject post(String path, List<UUID> ids, boolean withToken) throws Exception {
        JsonArray list = new JsonArray();
        for (UUID id : ids) list.add(compact(id));
        JsonObject body = new JsonObject();
        body.add("players", list);
        HttpRequest.Builder req = HttpRequest.newBuilder(URI.create(VitraCosmetics.API + path))
            .timeout(Duration.ofSeconds(10))
            .header("content-type", "application/json")
            .header("user-agent", "VitraCosmetics/1.0")
            .POST(HttpRequest.BodyPublishers.ofString(body.toString()));
        if (withToken) req.header("authorization", "Bearer " + VitraCosmetics.TOKEN);
        HttpResponse<String> res = http.send(req.build(), HttpResponse.BodyHandlers.ofString());
        if (res.statusCode() == 401) return null;
        if (res.statusCode() != 200) throw new IllegalStateException("HTTP " + res.statusCode());
        return JsonParser.parseString(res.body()).getAsJsonObject();
    }

    private static void store(List<UUID> asked, JsonObject res, long now) {
        JsonObject found = res.getAsJsonObject("players");
        for (UUID id : asked) {
            JsonElement el = found.get(compact(id));
            if (el == null || !el.isJsonObject()) {
                players.put(id, new Entry(false, false, null, null, now));
                continue;
            }
            JsonObject o = el.getAsJsonObject();
            Cape cape = null;
            if (o.has("cape") && o.get("cape").isJsonObject()) {
                JsonObject c = o.getAsJsonObject("cape");
                cape = new Cape(c.get("id").getAsString(), c.get("url").getAsString(), c.get("w").getAsInt(),
                    c.get("h").getAsInt(), c.get("frames").getAsInt(), c.get("delay").getAsInt());
            }
            String badge = o.has("badge") ? o.get("badge").getAsString() : "vitra";
            players.put(id, new Entry(true, o.get("online").getAsBoolean(), badge, cape, now));
        }
    }

    private static String compact(UUID id) {
        return id.toString().replace("-", "");
    }
}
