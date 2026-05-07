"""
Claude LLM Client Wrapper
"""
from anthropic import Anthropic
from config import settings


class ClaudeClient:
    """Wrapper around Anthropic SDK for conversation management"""
    
    def __init__(self):
        self.client = Anthropic(api_key=settings.ANTHROPIC_API_KEY)
        self.model = settings.LLM_MODEL
        self.max_tokens = settings.LLM_MAX_TOKENS
        self.conversation_history = []
    
    def send_message(self, user_message: str) -> str:
        """
        Send a message and get a response from Claude
        
        Args:
            user_message: The user's input
            
        Returns:
            Claude's response text
        """
        # Add user message to history
        self.conversation_history.append({
            "role": "user",
            "content": user_message
        })
        
        # Call Claude API
        response = self.client.messages.create(
            model=self.model,
            max_tokens=self.max_tokens,
            messages=self.conversation_history
        )
        
        # Extract response text
        assistant_message = response.content[0].text
        
        # Add to history
        self.conversation_history.append({
            "role": "assistant",
            "content": assistant_message
        })
        
        return assistant_message
    
    def clear_history(self):
        """Clear conversation history"""
        self.conversation_history = []
    
    def get_history(self):
        """Get current conversation history"""
        return self.conversation_history
