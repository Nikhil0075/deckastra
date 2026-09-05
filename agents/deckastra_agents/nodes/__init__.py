"""Graph nodes.

Each node is a plain function from state to a state fragment. That is a
deliberate constraint: LangGraph builds the graph and owns the edges, but nothing
in this package imports it, so a node can be called directly in a test and the
framework stays replaceable (doc 03 §24's argument, applied to the graph library
rather than the model provider).
"""

from .orchestrate import orchestrate
from .research import research
from .story import story
from .creative import creative
from .layout import layout
from .motion import motion
from .critic import critic
from .propose import propose

__all__ = [
    "orchestrate",
    "research",
    "story",
    "creative",
    "layout",
    "motion",
    "critic",
    "propose",
]
