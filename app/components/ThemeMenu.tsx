import { Button, DropdownMenu, Tooltip } from "@cloudflare/kumo";
import { MonitorIcon, MoonIcon, SunIcon } from "@phosphor-icons/react";
import { useCallback } from "react";
import { isTheme, type Theme, useTheme } from "~/hooks/useTheme";

const THEME_META: Record<Theme, { label: string; Icon: typeof SunIcon }> = {
	light: { label: "Light", Icon: SunIcon },
	dark: { label: "Dark", Icon: MoonIcon },
	system: { label: "System", Icon: MonitorIcon },
};

const THEME_ORDER: Theme[] = ["light", "dark", "system"];

export default function ThemeMenu() {
	const { theme, setTheme } = useTheme();
	const { label, Icon } = THEME_META[theme];

	const handleValueChange = useCallback(
		(next: unknown) => {
			if (!isTheme(next)) return;
			setTheme(next);
		},
		[setTheme],
	);

	return (
		<DropdownMenu>
			<Tooltip content="Theme" side="bottom" asChild>
				<DropdownMenu.Trigger>
					<Button
						variant="ghost"
						shape="square"
						icon={<Icon size={20} />}
						aria-label={`Theme: ${label}`}
					/>
				</DropdownMenu.Trigger>
			</Tooltip>
			<DropdownMenu.Content>
				<DropdownMenu.RadioGroup value={theme} onValueChange={handleValueChange}>
					{THEME_ORDER.map((id) => {
						const ItemIcon = THEME_META[id].Icon;
						return (
							<DropdownMenu.RadioItem
								key={id}
								value={id}
								icon={<ItemIcon size={16} />}
								closeOnClick
							>
								{THEME_META[id].label}
								<DropdownMenu.RadioItemIndicator />
							</DropdownMenu.RadioItem>
						);
					})}
				</DropdownMenu.RadioGroup>
			</DropdownMenu.Content>
		</DropdownMenu>
	);
}
