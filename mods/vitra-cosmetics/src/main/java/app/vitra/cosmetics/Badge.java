package app.vitra.cosmetics;

import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.FontDescription;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.network.chat.Style;
import net.minecraft.resources.Identifier;

import java.util.UUID;

public final class Badge {
    private static final Style STYLE = Style.EMPTY
        .withFont(new FontDescription.Resource(Identifier.fromNamespaceAndPath("vitra", "badge")))
        .withColor(0xFFFFFF)
        .withoutShadow();
    private static final Component VITRA = Component.literal("\uE000").setStyle(STYLE);
    private static final Component[] OWNER = new Component[16];
    private static final int OWNER_FRAME_MS = 75;
    private static final Component[] RUINEDNZ = new Component[16];
    private static final int RUINEDNZ_FRAME_MS = 110;

    static {
        for (int i = 0; i < OWNER.length; i++) OWNER[i] = Component.literal(String.valueOf((char) (0xE100 + i))).setStyle(STYLE);
        for (int i = 0; i < RUINEDNZ.length; i++) RUINEDNZ[i] = Component.literal(String.valueOf((char) (0xE200 + i))).setStyle(STYLE);
    }

    private Badge() {}

    public static Component decorate(UUID player, Component name) {
        if (!VitraCosmetics.badgesAvailable || name == null) return name;
        String kind = Directory.badge(player);
        if (kind == null) return name;
        Component glyph = switch (kind) {
            case "owner" -> frame(OWNER, OWNER_FRAME_MS);
            case "ruinednz" -> frame(RUINEDNZ, RUINEDNZ_FRAME_MS);
            default -> VITRA;
        };
        MutableComponent out = Component.empty();
        out.append(glyph).append(Component.literal(" ")).append(name);
        return out;
    }

    private static Component frame(Component[] frames, int frameMs) {
        return frames[(int) ((System.currentTimeMillis() / frameMs) % frames.length)];
    }
}
