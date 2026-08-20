from __future__ import annotations

import json
import re
import subprocess
import unittest
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]


class DashboardPolishTests(unittest.TestCase):
    def test_search_action_hover_keeps_the_rounded_right_edge(self) -> None:
        css = (PROJECT / "public" / "search-polish.css").read_text(encoding="utf-8")
        match = re.search(r"#search-submit:hover\s*\{(?P<body>.*?)\}", css, re.S)
        self.assertIsNotNone(match)
        body = match.group("body")
        self.assertIn("border-top-right-radius: 16px", body)
        self.assertIn("border-bottom-right-radius: 16px", body)

    def test_per_tile_appearance_controls_are_accessible_and_mobile_safe(self) -> None:
        page = (PROJECT / "public" / "index.html").read_text(encoding="utf-8")
        script = (PROJECT / "public" / "app.js").read_text(encoding="utf-8")
        styles = (PROJECT / "public" / "styles.css").read_text(encoding="utf-8")

        self.assertIn('id="appearance-dialog" aria-labelledby="appearance-heading"', page)
        self.assertIn('name="tile_dim"', page)
        self.assertIn('name="icon_invert"', page)
        self.assertIn('aria-label="Adjust tile appearance for ${esc(x.title)}"', script)
        self.assertIn("data-appearance", script)
        self.assertIn("--tile-dim", styles)
        self.assertIn("--icon-invert", styles)
        self.assertIn("@media (hover:none),(pointer:coarse)", styles)

        appearance_dialog = re.search(
            r'<dialog id="appearance-dialog".*?</dialog>', page, re.S
        )
        self.assertIsNotNone(appearance_dialog)
        appearance_markup = appearance_dialog.group(0)
        self.assertIn("Saved automatically", appearance_markup)
        self.assertIn(">Done</button>", appearance_markup)
        self.assertNotIn(">Cancel</button>", appearance_markup)
        self.assertNotIn(">Save appearance</button>", appearance_markup)

        self.assertIn("addEventListener('change'", script)
        self.assertIn("requestAppearanceSave()", script)
        self.assertIn("requestAppearanceSave(true)", script)
        self.assertIn("Restored the last saved appearance", script)
        input_handler = re.search(
            r"#appearance-form'\)\.addEventListener\('input'.*?\);", script
        )
        self.assertIsNotNone(input_handler)
        self.assertNotIn("/api/items/", input_handler.group(0))

        self.assertIn(
            ".tile.light-tile.darkened-light-tile{background-clip:padding-box!important",
            styles,
        )
        self.assertIn(".tile.light-tile.darkened-light-tile:hover", styles)
        self.assertIn(
            ".appearance-preview.light-tile.darkened-light-tile{background-clip:padding-box!important",
            styles,
        )

    def test_dimmed_white_tile_uses_the_higher_wcag_contrast(self) -> None:
        script = (PROJECT / "public" / "app.js").read_text(encoding="utf-8")
        function_names = (
            "tileColorChannels",
            "tileLuminance",
            "lightTile",
            "appearanceLevel",
            "relativeLuminance",
            "contrastRatio",
            "needsLightTileText",
        )
        definitions = []
        for name in function_names:
            match = re.search(rf"^function {name}\([^\n]+$", script, re.M)
            self.assertIsNotNone(match, f"missing JavaScript function {name}")
            definitions.append(match.group(0))
        probe = """
const results=[44,54].map(dim=>{
  const background=tileColorChannels('#ffffff').map(value=>Math.round(value*(1-dim/100)));
  const useLight=needsLightTileText({color:'#ffffff',tile_dim:dim});
  const selected=useLight?[255,255,255]:[0,0,0];
  return {dim,useLight,contrast:contrastRatio(background,selected)};
});
const minimum=Math.min(...Array.from({length:91},(_,dim)=>{
  const background=[255,255,255].map(value=>Math.round(value*(1-dim/100)));
  const useLight=needsLightTileText({color:'#ffffff',tile_dim:dim});
  return contrastRatio(background,useLight?[255,255,255]:[0,0,0]);
}));
console.log(JSON.stringify({results,minimum}));
"""
        completed = subprocess.run(
            ["node", "-e", "\n".join(definitions) + probe],
            check=True,
            capture_output=True,
            text=True,
        )
        result = json.loads(completed.stdout)
        self.assertEqual(result["results"][0]["dim"], 44)
        self.assertFalse(result["results"][0]["useLight"])
        self.assertEqual(result["results"][1]["dim"], 54)
        self.assertTrue(result["results"][1]["useLight"])
        self.assertGreaterEqual(result["minimum"], 4.5)


if __name__ == "__main__":
    unittest.main()
