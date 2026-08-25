"""Scene entities for SmartThings Web."""

from __future__ import annotations

from homeassistant.components.scene import Scene
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import SmartThingsWebConfigEntry
from .bridge_client import BridgeClientError
from .models import BridgeScene, SmartThingsWebRuntime, scene_unique_id


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SmartThingsWebConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Create SmartThings scenes and discover new ones from inventory pushes."""
    runtime = entry.runtime_data
    known: set[str] = set()

    def discover() -> None:
        entities = []
        for scene in runtime.inventory.scenes.values():
            if scene.location_id != runtime.location_id:
                continue
            if scene.scene_id in known:
                continue
            known.add(scene.scene_id)
            entities.append(SmartThingsWebScene(runtime, scene))
        if entities:
            async_add_entities(entities)

    discover()
    entry.async_on_unload(runtime.subscribe(discover))


class SmartThingsWebScene(Scene):
    """One SmartThings scene."""

    _attr_should_poll = False

    def __init__(self, runtime: SmartThingsWebRuntime, scene: BridgeScene) -> None:
        self.runtime = runtime
        self.scene_id = scene.scene_id
        self._attr_name = scene.name
        self._attr_unique_id = scene_unique_id(scene.scene_id)

    @property
    def available(self) -> bool:
        """Return whether the scene is still present."""
        scene = self.runtime.inventory.scenes.get(self.scene_id)
        return scene is not None and scene.location_id == self.runtime.location_id

    async def async_added_to_hass(self) -> None:
        """Subscribe to Bridge pushes."""
        self.async_on_remove(self.runtime.subscribe(self.async_write_ha_state))

    async def async_activate(self, **kwargs: object) -> None:
        """Activate the SmartThings scene via the Bridge."""
        try:
            await self.runtime.client.async_execute_command(
                target_type="scene",
                target_id=self.scene_id,
                command="execute",
                arguments=[],
            )
        except BridgeClientError as err:
            raise HomeAssistantError("SmartThings Web did not confirm scene execution") from err
