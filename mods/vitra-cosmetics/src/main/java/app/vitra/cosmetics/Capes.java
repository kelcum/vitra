package app.vitra.cosmetics;

import com.mojang.blaze3d.platform.NativeImage;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.texture.DynamicTexture;
import net.minecraft.core.ClientAsset;
import net.minecraft.resources.Identifier;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * Downloads Vitra capes and turns each animation frame into a texture. The cape handed to the
 * renderer picks the current frame every time it's drawn, so animated capes play by themselves.
 * Capes nobody has drawn for a while are freed again.
 */
public final class Capes {
    /** Capes only come from Vitra's server. */
    private static final String CAPE_URL = VitraCosmetics.API + "/v1/capes/";
    /** The server's limits: 256 px wide at most, and 256×128×48 pixels across all frames. */
    private static final int MAX_WIDTH = 256;
    private static final long MAX_PIXELS = 256L * 128 * 48;
    private static final long UNUSED_MS = TimeUnit.MINUTES.toMillis(5);
    private static final long SWEEP_MS = TimeUnit.SECONDS.toMillis(30);

    private static final Map<String, Animated> loaded = new ConcurrentHashMap<>();
    private static final Map<String, Long> lastUsed = new ConcurrentHashMap<>();
    private static final Set<String> started = ConcurrentHashMap.newKeySet();
    private static final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(8)).build();
    private static long lastSweep;

    private Capes() {}

    /** The texture to draw as this player's cape, or null to leave their cape alone (still loading, or no Vitra cape). Game thread. */
    public static ClientAsset.Texture textureFor(UUID player) {
        long now = System.currentTimeMillis();
        if (now - lastSweep > SWEEP_MS) {
            lastSweep = now;
            freeUnused(now);
        }
        Directory.Cape cape = Directory.cape(player);
        if (cape == null) return null;
        Animated tex = loaded.get(cape.id());
        if (tex != null) lastUsed.put(cape.id(), now);
        else if (started.add(cape.id())) download(cape);
        return tex;
    }

    private static void download(Directory.Cape cape) {
        if (!cape.url().startsWith(CAPE_URL) || !fits(cape.width(), cape.height())) {
            VitraCosmetics.LOG.warn("Skipping cape {}: not from Vitra's server, or too big", cape.id());
            return;                                          // stays in `started`, so it isn't tried again
        }
        HttpRequest req = HttpRequest.newBuilder(URI.create(cape.url())).timeout(Duration.ofSeconds(20))
            .header("user-agent", "VitraCosmetics/1.0").build();
        http.sendAsync(req, HttpResponse.BodyHandlers.ofByteArray()).whenComplete((res, err) -> {
            if (err != null || res.statusCode() != 200) {
                VitraCosmetics.LOG.warn("Couldn't download cape {}: {}", cape.id(), err != null ? err.toString() : "HTTP " + res.statusCode());
                started.remove(cape.id());                     // try again next time it's needed
                return;
            }
            Minecraft.getInstance().execute(() -> register(cape, res.body()));
        });
    }

    private static boolean fits(long width, long height) {
        return width > 0 && width <= MAX_WIDTH && width * height <= MAX_PIXELS;
    }

    /** Splits the image into frames (stacked top to bottom) and registers one texture per frame. Game thread only. */
    private static void register(Directory.Cape cape, byte[] png) {
        // Check the size the PNG declares (IHDR) before decoding it.
        if (png.length < 24 || !fits(readInt(png, 16), readInt(png, 20))) {
            VitraCosmetics.LOG.warn("Skipping cape {}: the image is too big", cape.id());
            return;
        }
        try (NativeImage all = NativeImage.read(png)) {
            int w = all.getWidth(), frameH = w / 2;
            int frames = Math.max(1, Math.min(cape.frames(), all.getHeight() / frameH));
            Identifier[] ids = new Identifier[frames];
            for (int i = 0; i < frames; i++) {
                NativeImage frame = new NativeImage(w, frameH, true);
                all.copyRect(frame, 0, i * frameH, 0, 0, w, frameH, false, false);
                ids[i] = Identifier.fromNamespaceAndPath("vitra", "capes/" + cape.id() + "/" + i);
                int n = i;
                Minecraft.getInstance().getTextureManager().register(ids[i], new DynamicTexture(() -> "Vitra cape " + cape.id() + " #" + n, frame));
            }
            loaded.put(cape.id(), new Animated(ids[0], ids, Math.max(20, cape.delay())));
            lastUsed.put(cape.id(), System.currentTimeMillis());
        } catch (Exception e) {
            VitraCosmetics.LOG.warn("Couldn't read cape {}", cape.id(), e);
        }
    }

    /** Frees capes nobody has drawn for a while. Game thread. */
    private static void freeUnused(long now) {
        for (Map.Entry<String, Animated> e : loaded.entrySet()) {
            String id = e.getKey();
            if (now - lastUsed.getOrDefault(id, 0L) < UNUSED_MS) continue;
            loaded.remove(id);
            lastUsed.remove(id);
            started.remove(id);
            for (Identifier frame : e.getValue().frames()) Minecraft.getInstance().getTextureManager().release(frame);
        }
    }

    private static long readInt(byte[] b, int at) {
        return ((b[at] & 0xFFL) << 24) | ((b[at + 1] & 0xFFL) << 16) | ((b[at + 2] & 0xFFL) << 8) | (b[at + 3] & 0xFFL);
    }

    /** A cape texture that shows a different frame depending on the time. */
    private record Animated(Identifier id, Identifier[] frames, int delay) implements ClientAsset.Texture {
        @Override
        public Identifier texturePath() {
            if (frames.length == 1) return frames[0];
            return frames[(int) ((System.currentTimeMillis() / delay) % frames.length)];
        }
    }
}
