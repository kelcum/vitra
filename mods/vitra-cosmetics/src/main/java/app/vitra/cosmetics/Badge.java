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

    static {
        for (int i = 0; i < OWNER.length; i++) OWNER[i] = Component.literal(String.valueOf((char) (0xE100 + i))).setStyle(STYLE);
    }

    private Badge() {}

    public static Component decorate(UUID player, Component name) {
        if (!VitraCosmetics.badgesAvailable || name == null) return name;
        String kind = Directory.badge(player);
        if (kind == null) return name;
        Component glyph = "owner".equals(kind) ? OWNER[(int) ((System.currentTimeMillis() / OWNER_FRAME_MS) % OWNER.length)] : VITRA;
        MutableComponent out = Component.empty();
        out.append(glyph).append(Component.literal(" ")).append(name);
        return out;
    }
}
