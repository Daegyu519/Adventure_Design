
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "invites": {
                  Row: {
                    "code": string,"expires_at": string,"inviter_id": string,"max_uses": number,"relation": string,"room_id": string | null,"uses": number
                  }
                  ComputedFields: never
                  Insert: {
                    "code": string,"expires_at": string,"inviter_id": string,"max_uses": number,"relation": string,"room_id"?: string | null,"uses"?: number
                  }
                  Update: {
                    "code"?: string,"expires_at"?: string,"inviter_id"?: string,"max_uses"?: number,"relation"?: string,"room_id"?: string | null,"uses"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "invites_inviter_id_fkey"
      columns: ["inviter_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "invites_room_id_fkey"
      columns: ["room_id"]
isOneToOne: false
      referencedRelation: "rooms"
      referencedColumns: ["id"]
    }
                  ]
                },"messages": {
                  Row: {
                    "created_at": string,"file_name": string | null,"file_path": string | null,"file_size": number | null,"id": number,"image_path": string | null,"mentions": (string)[],"reply_to": number | null,"room_id": string,"sender_id": string,"text": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"file_name"?: string | null,"file_path"?: string | null,"file_size"?: number | null,"id"?: never,"image_path"?: string | null,"mentions"?: (string)[],"reply_to"?: number | null,"room_id": string,"sender_id": string,"text"?: string
                  }
                  Update: {
                    "created_at"?: string,"file_name"?: string | null,"file_path"?: string | null,"file_size"?: number | null,"id"?: never,"image_path"?: string | null,"mentions"?: (string)[],"reply_to"?: number | null,"room_id"?: string,"sender_id"?: string,"text"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "messages_reply_to_fkey"
      columns: ["reply_to"]
isOneToOne: false
      referencedRelation: "messages"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "messages_room_id_fkey"
      columns: ["room_id"]
isOneToOne: false
      referencedRelation: "rooms"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "messages_sender_id_fkey"
      columns: ["sender_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"mirror_attempts": {
                  Row: {
                    "answer_score": number | null,"card_ref": string,"created_at": string,"gap": number | null,"id": number,"kind": string,"panel_bin": number | null,"predicted": number | null,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "answer_score"?: number | null,"card_ref": string,"created_at"?: string,"gap"?: number | null,"id"?: never,"kind": string,"panel_bin"?: number | null,"predicted"?: number | null,"user_id": string
                  }
                  Update: {
                    "answer_score"?: number | null,"card_ref"?: string,"created_at"?: string,"gap"?: number | null,"id"?: never,"kind"?: string,"panel_bin"?: number | null,"predicted"?: number | null,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "mirror_attempts_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "created_at": string,"id": string,"name": string,"tone_hint_on": boolean
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id": string,"name": string,"tone_hint_on"?: boolean
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"name"?: string,"tone_hint_on"?: boolean
                  }
                  Relationships: [
                    
                  ]
                },"push_tokens": {
                  Row: {
                    "platform": string,"token": string,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "platform": string,"token": string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "platform"?: string,"token"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "push_tokens_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"reactions": {
                  Row: {
                    "created_at": string,"emoji": string,"message_id": number,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"emoji": string,"message_id": number,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"emoji"?: string,"message_id"?: number,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "reactions_message_id_fkey"
      columns: ["message_id"]
isOneToOne: false
      referencedRelation: "messages"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "reactions_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"room_members": {
                  Row: {
                    "joined_at": string,"last_read_at": string | null,"muted": boolean,"room_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "joined_at"?: string,"last_read_at"?: string | null,"muted"?: boolean,"room_id": string,"user_id": string
                  }
                  Update: {
                    "joined_at"?: string,"last_read_at"?: string | null,"muted"?: boolean,"room_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "room_members_room_id_fkey"
      columns: ["room_id"]
isOneToOne: false
      referencedRelation: "rooms"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "room_members_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"rooms": {
                  Row: {
                    "created_at": string,"created_by": string | null,"id": string,"kind": string,"relation": string,"title": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"kind": string,"relation": string,"title"?: string | null
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"kind"?: string,"relation"?: string,"title"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "rooms_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"tone_events": {
                  Row: {
                    "choice": string | null,"created_at": string,"id": number,"kind": string,"risk": number | null,"room_id": string,"signals": Json | null,"top_reading": string | null,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "choice"?: string | null,"created_at"?: string,"id"?: never,"kind": string,"risk"?: number | null,"room_id": string,"signals"?: Json | null,"top_reading"?: string | null,"user_id": string
                  }
                  Update: {
                    "choice"?: string | null,"created_at"?: string,"id"?: never,"kind"?: string,"risk"?: number | null,"room_id"?: string,"signals"?: Json | null,"top_reading"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "tone_events_room_id_fkey"
      columns: ["room_id"]
isOneToOne: false
      referencedRelation: "rooms"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tone_events_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "accept_invite":
{ Args: { "code": string }; Returns: string
                           },
"create_group":
{ Args: { "relation": string,"title": string }; Returns: string
                           },
"create_invite":
{ Args: { "relation"?: string,"room"?: string }; Returns: string
                           },
"is_member":
{ Args: { "room": string }; Returns: boolean
                           },
"register_push_token":
{ Args: { "p_platform": string,"p_token": string }; Returns: undefined
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {
            
          }
        }
} as const
