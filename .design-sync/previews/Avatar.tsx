import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "nteract-elements";

export function ImageAvatar() {
  return (
    <Avatar>
      <AvatarImage src="https://github.com/rgbkrk.png" alt="rgbkrk" />
      <AvatarFallback>RK</AvatarFallback>
    </Avatar>
  );
}

export function FallbackInitials() {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      <Avatar>
        <AvatarFallback>KK</AvatarFallback>
      </Avatar>
      <Avatar>
        <AvatarFallback>DS</AvatarFallback>
      </Avatar>
    </div>
  );
}

export function Sizes() {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      <Avatar size="sm">
        <AvatarImage src="https://github.com/rgbkrk.png" alt="rgbkrk" />
        <AvatarFallback>RK</AvatarFallback>
      </Avatar>
      <Avatar size="default">
        <AvatarImage src="https://github.com/rgbkrk.png" alt="rgbkrk" />
        <AvatarFallback>RK</AvatarFallback>
      </Avatar>
      <Avatar size="lg">
        <AvatarImage src="https://github.com/rgbkrk.png" alt="rgbkrk" />
        <AvatarFallback>RK</AvatarFallback>
      </Avatar>
    </div>
  );
}

export function WithBadge() {
  return (
    <Avatar size="lg">
      <AvatarImage src="https://github.com/rgbkrk.png" alt="rgbkrk" />
      <AvatarFallback>RK</AvatarFallback>
      <AvatarBadge />
    </Avatar>
  );
}

export function CollaboratorGroup() {
  return (
    <AvatarGroup>
      <Avatar>
        <AvatarImage src="https://github.com/rgbkrk.png" alt="rgbkrk" />
        <AvatarFallback>RK</AvatarFallback>
      </Avatar>
      <Avatar>
        <AvatarFallback>KK</AvatarFallback>
      </Avatar>
      <Avatar>
        <AvatarFallback>DS</AvatarFallback>
      </Avatar>
      <AvatarGroupCount>+4</AvatarGroupCount>
    </AvatarGroup>
  );
}
